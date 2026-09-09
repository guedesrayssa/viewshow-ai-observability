import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import {
  ServiceError,
  authenticatedIdentitySchema,
  assertNoPhysicalFields,
  createLogger,
  diagnosisDataSchema,
  errorEnvelope,
  eventsDataRuntimeSchema,
  eventsQuerySchema,
  incidentsDataSchema,
  incidentsQuerySchema,
  monitoringProjectionSchema,
  monitoringQuerySchema,
  opaqueIdSchema,
  overviewProjectionSchema,
  overviewQuerySchema,
  requestId,
  reviewDataRuntimeSchema,
  reviewBodySchema,
  successEnvelope,
  validationError,
} from "@view-show/contracts";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import {
  ServiceClient,
  type FullServiceResponse,
} from "./infrastructure/service-client.js";
import { Metrics } from "./observability/metrics.js";

const logger = createLogger("api-gateway");

function requestIdentifier(request: Request): string {
  const candidate = request.header("x-request-id");
  return candidate && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate)
    ? candidate
    : requestId();
}

function queryPath(
  path: string,
  query: Readonly<Record<string, unknown>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function rateLimiter(limit: number): express.RequestHandler {
  const clients = new Map<string, { count: number; resetAt: number }>();
  return (request, _response, next) => {
    const now = Date.now();
    const key = request.ip ?? "unknown";
    const current = clients.get(key);
    const entry =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + 60_000 }
        : current;
    entry.count += 1;
    clients.set(key, entry);
    if (entry.count > limit)
      return next(
        new ServiceError(
          429,
          "RATE_LIMITED",
          "Limite de requisições excedido.",
        ),
      );
    next();
  };
}

function forward(response: Response, upstream: FullServiceResponse): void {
  const cookie = upstream.headers.get("set-cookie");
  if (cookie) response.setHeader("set-cookie", cookie);
  if (upstream.status === 204) {
    response.status(204).end();
    return;
  }
  response.status(upstream.status).json(upstream.body);
}

export function createApp(config: GatewayConfig) {
  const app = express();
  const metrics = new Metrics("api-gateway");
  const incidents = new ServiceClient(
    config.services.incidents,
    config.internalToken,
    config.timeoutMs,
  );
  const dashboard = new ServiceClient(
    config.services.dashboard,
    config.internalToken,
    config.timeoutMs,
  );
  const identity = new ServiceClient(
    config.services.identity,
    config.internalToken,
    config.timeoutMs,
  );

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || config.frontendOrigins.includes(origin))
          callback(null, true);
        else
          callback(
            new ServiceError(403, "FORBIDDEN", "Origem não autorizada."),
          );
      },
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Accept", "Content-Type", "X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use((request, response, next) => {
    response.locals.requestId = requestIdentifier(request);
    response.setHeader("x-request-id", response.locals.requestId as string);
    const started = process.hrtime.bigint();
    response.once("finish", () =>
      logger.info("request completed", {
        request_id: response.locals.requestId,
        method: request.method,
        route: `${request.baseUrl}${typeof request.route?.path === "string" ? request.route.path : request.path}`,
        status: response.statusCode,
        duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000,
      }),
    );
    next();
  });
  app.use(metrics.middleware());

  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  if (config.metricsEnabled) {
    app.get("/metrics", async (_request, response) => {
      response.setHeader("content-type", metrics.registry.contentType);
      response.end(await metrics.registry.metrics());
    });
  }
  app.use(rateLimiter(180));

  const authProxy =
    (method: "GET" | "POST", path: string) =>
    async (request: Request, response: Response, next: NextFunction) => {
      try {
        const cookie = request.header("cookie");
        const upstream = await identity.request({
          method,
          path: `/internal/v1/auth/${path}`,
          requestId: response.locals.requestId as string,
          ...(cookie ? { cookie } : {}),
          ...(method === "POST" ? { body: request.body as unknown } : {}),
        });
        forward(response, upstream);
      } catch (error) {
        next(error);
      }
    };
  app.post("/auth/login", authProxy("POST", "login"));
  app.post("/auth/register", authProxy("POST", "register"));
  app.post("/auth/recover", authProxy("POST", "recover"));
  app.post("/auth/logout", authProxy("POST", "logout"));
  app.get("/auth/sso", authProxy("GET", "sso"));
  app.get("/auth/session", async (request, response, next) => {
    try {
      const cookie = request.header("cookie");
      const upstream = await identity.request({
        path: "/internal/v1/session",
        requestId: response.locals.requestId as string,
        ...(cookie ? { cookie } : {}),
      });
      forward(response, upstream);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/dashboard/overview", async (request, response, next) => {
    try {
      const parsed = overviewQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const result = await dashboard.get(
        queryPath("/internal/v1/dashboard/overview", parsed.data),
        response.locals.requestId as string,
        overviewProjectionSchema,
      );
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/incidents", async (request, response, next) => {
    try {
      const parsed = incidentsQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const result = await incidents.get(
        queryPath("/internal/v1/incidents", parsed.data),
        response.locals.requestId as string,
        incidentsDataSchema,
      );
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/v1/incidents/:incidentId/diagnosis",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const result = await incidents.get(
          `/internal/v1/incidents/${encodeURIComponent(incidentId)}/diagnosis`,
          response.locals.requestId as string,
          diagnosisDataSchema,
        );
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/v1/incidents/:incidentId/events",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const parsed = eventsQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        const result = await incidents.get(
          queryPath(
            `/internal/v1/incidents/${encodeURIComponent(incidentId)}/events`,
            parsed.data,
          ),
          response.locals.requestId as string,
          eventsDataRuntimeSchema,
        );
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/v1/incidents/:incidentId/events/:eventId",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const eventId = opaqueIdSchema.parse(request.params.eventId);
        const result = await incidents.get(
          `/internal/v1/incidents/${encodeURIComponent(incidentId)}/events/${encodeURIComponent(eventId)}`,
          response.locals.requestId as string,
          z.record(z.string(), z.unknown()),
        );
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/v1/incidents/:incidentId/hypotheses/:hypothesisId/review",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const hypothesisId = opaqueIdSchema.parse(request.params.hypothesisId);
        const parsed = reviewBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const cookie = request.header("cookie");
        const session = await identity.request({
          path: "/internal/v1/session",
          requestId: response.locals.requestId as string,
          ...(cookie ? { cookie } : {}),
        });
        const identityBody =
          session.body !== null &&
          typeof session.body === "object" &&
          "identity" in session.body
            ? session.body.identity
            : null;
        const actorResult = authenticatedIdentitySchema.safeParse(identityBody);
        if (!actorResult.success)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const actor = actorResult.data;
        if (actor.role !== "engineer" && actor.role !== "admin")
          throw new ServiceError(
            403,
            "FORBIDDEN",
            "O usuário não pode revisar hipóteses.",
          );
        const result = await incidents.mutate(
          {
            method: "PATCH",
            path: `/internal/v1/incidents/${encodeURIComponent(incidentId)}/hypotheses/${encodeURIComponent(hypothesisId)}/review`,
            requestId: response.locals.requestId as string,
            reviewerId: actor.id,
            body: parsed.data,
          },
          reviewDataRuntimeSchema,
        );
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/v1/monitoring/overview", async (request, response, next) => {
    try {
      const parsed = monitoringQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const result = await dashboard.get(
        queryPath("/internal/v1/monitoring/overview", parsed.data),
        response.locals.requestId as string,
        monitoringProjectionSchema,
      );
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, _response, next) =>
    next(new ServiceError(404, "RESOURCE_NOT_FOUND", "Rota não encontrada.")),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const serviceError =
        error instanceof ServiceError
          ? error
          : new ServiceError(
              500,
              "INTERNAL_ERROR",
              "Falha interna no gateway.",
            );
      if (!(error instanceof ServiceError))
        logger.error("unhandled request error", {
          request_id: response.locals.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      response
        .status(serviceError.status)
        .json(errorEnvelope(serviceError, response.locals.requestId as string));
    },
  );
  return app;
}

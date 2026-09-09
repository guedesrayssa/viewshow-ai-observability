import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import {
  ServiceError,
  assertNoPhysicalFields,
  createLogger,
  errorEnvelope,
  eventsQuerySchema,
  incidentsQuerySchema,
  monitoringQuerySchema,
  opaqueIdSchema,
  overviewQuerySchema,
  requestId,
  reviewBodySchema,
  successEnvelope,
  validationError,
  type AuthenticatedIdentity,
} from "@view-show/contracts";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import type { AuthModule } from "./modules/auth/index.js";
import { parseCookie } from "./modules/auth/index.js";
import type { DashboardQueries } from "./modules/dashboard/index.js";
import type { IncidentUseCases } from "./modules/incidents/index.js";
import { Metrics } from "./observability/metrics.js";

const logger = createLogger("api");

const loginSchema = z
  .object({ email: z.email(), password: z.string().min(1).max(1024) })
  .strict();

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly incidents: IncidentUseCases;
  readonly dashboard: DashboardQueries;
  readonly auth: AuthModule;
}

function requestIdentifier(request: Request): string {
  const candidate = request.header("x-request-id");
  return candidate && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate)
    ? candidate
    : requestId();
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

export function createApp(deps: AppDependencies) {
  const { config, incidents, dashboard, auth } = deps;
  const app = express();
  const metrics = new Metrics("api");
  const sessionCookieSecure = auth.nodeEnv === "production";

  function issueSession(
    response: Response,
    identity: AuthenticatedIdentity,
  ): void {
    response.cookie("session", auth.sessions.issue(identity), {
      httpOnly: true,
      secure: sessionCookieSecure,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });
  }

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

  app.post("/auth/login", async (request, response, next) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const identity = await auth.useCases.login(
        parsed.data.email,
        parsed.data.password,
      );
      issueSession(response, identity);
      response.json({
        status: "ok",
        name: identity.name,
        role: identity.role,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/auth/logout", (_request, response) => {
    response.clearCookie("session", {
      httpOnly: true,
      secure: sessionCookieSecure,
      sameSite: "lax",
      path: "/",
    });
    response.status(204).end();
  });

  app.post("/auth/register", (_request, _response, next) => {
    try {
      auth.useCases.unavailable("Cadastro local");
    } catch (error) {
      next(error);
    }
  });
  app.post("/auth/recover", (_request, _response, next) => {
    try {
      auth.useCases.unavailable("Recuperação de senha local");
    } catch (error) {
      next(error);
    }
  });
  app.get("/auth/sso", (_request, _response, next) => {
    try {
      auth.useCases.unavailable("SSO");
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/session", (request, response, next) => {
    const identity = auth.sessions.verify(
      parseCookie(request.header("cookie"), "session"),
    );
    if (!identity)
      return next(
        new ServiceError(
          401,
          "UNAUTHENTICATED",
          "Sessão inválida, ausente ou expirada.",
        ),
      );
    response.json({ identity });
  });

  app.get("/api/v1/dashboard/overview", async (request, response, next) => {
    try {
      const parsed = overviewQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const result = await dashboard.overview(parsed.data);
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
      const result = await incidents.list(parsed.data);
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
        const result = await incidents.diagnosis(incidentId);
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
        const result = await incidents.events(incidentId, parsed.data.limit);
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
    (request, response, next) => {
      try {
        opaqueIdSchema.parse(request.params.incidentId);
        opaqueIdSchema.parse(request.params.eventId);
        incidents.event();
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
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        if (actor.role !== "engineer" && actor.role !== "admin")
          throw new ServiceError(
            403,
            "FORBIDDEN",
            "O usuário não pode revisar hipóteses.",
          );
        const result = await incidents.review(
          incidentId,
          hypothesisId,
          parsed.data,
          actor.id,
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
      const result = await dashboard.monitoring(parsed.data);
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
          : new ServiceError(500, "INTERNAL_ERROR", "Falha interna na API.");
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

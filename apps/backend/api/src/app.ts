import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import {
  ServiceError,
  assertNoPhysicalFields,
  authCallbackQuerySchema,
  completeImportBodySchema,
  createLogger,
  errorEnvelope,
  eventsQuerySchema,
  idempotencyKeySchema,
  incidentsQuerySchema,
  monitoringQuerySchema,
  opaqueIdSchema,
  overviewQuerySchema,
  requestId,
  rumTelemetrySchema,
  reviewBodySchema,
  startImportBodySchema,
  successEnvelope,
  validationError,
  type AuthenticatedIdentity,
} from "@view-show/contracts";
import type { ApiConfig } from "./config.js";
import type { AuthModule } from "./modules/auth/index.js";
import { parseCookie, passwordLoginBodySchema } from "./modules/auth/index.js";
import type { DashboardQueries } from "./modules/dashboard/index.js";
import type { IncidentUseCases } from "./modules/incidents/index.js";
import type { ImportUseCases } from "./modules/imports/index.js";
import { Metrics } from "./observability/metrics.js";
import { PUBLIC_ROUTES } from "./http/public-routes.js";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "view-show-api";
const logger = createLogger(SERVICE_NAME);

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly incidents: IncidentUseCases;
  readonly dashboard: DashboardQueries;
  readonly imports: ImportUseCases;
  readonly auth: AuthModule;
}

function requestIdentifier(request: Request): string {
  const candidate = request.header("x-request-id");
  return candidate && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate)
    ? candidate
    : requestId();
}

function opaqueId(value: string): string {
  const parsed = opaqueIdSchema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function isMalformedJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const bodyParserError = error as SyntaxError & {
    readonly status?: unknown;
    readonly type?: unknown;
  };
  return (
    bodyParserError.status === 400 &&
    bodyParserError.type === "entity.parse.failed"
  );
}

function isMalformedPathParameter(error: unknown): boolean {
  if (!(error instanceof URIError)) return false;
  const routerError = error as URIError & { readonly status?: unknown };
  return (
    routerError.status === 400 &&
    routerError.message.startsWith("Failed to decode param '") &&
    routerError.message.endsWith("'")
  );
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
  const { config, incidents, dashboard, imports, auth } = deps;
  const app = express();
  const metrics = new Metrics(SERVICE_NAME);
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
  if (auth.nodeEnv === "production") app.set("trust proxy", 1);
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
      allowedHeaders: [
        "Accept",
        "Content-Type",
        "Idempotency-Key",
        "X-Request-Id",
      ],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(metrics.middleware());

  app.get(PUBLIC_ROUTES.health.express, (_request, response) =>
    response.json({ status: "ok" }),
  );
  if (config.metricsEnabled) {
    app.get(PUBLIC_ROUTES.metrics.express, async (_request, response) => {
      response.setHeader("content-type", metrics.registry.contentType);
      response.end(await metrics.registry.metrics());
    });
  }
  app.post(
    PUBLIC_ROUTES.rumTelemetry.express,
    rateLimiter(600),
    (request, response, next) => {
      try {
        const parsed = rumTelemetrySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        metrics.observeRum(
          parsed.data.name,
          parsed.data.value,
          parsed.data.path,
          parsed.data.rating,
        );
        if (
          parsed.data.name === "frontend_client_errors_total" ||
          parsed.data.name === "frontend_api_fetch_errors_total"
        )
          logger.warn("frontend telemetry error observed", {
            request_id: response.locals.requestId,
            event: parsed.data.name,
            path: parsed.data.path,
          });
        response.status(202).end();
      } catch (error) {
        next(error);
      }
    },
  );
  app.use(rateLimiter(config.rateLimitPerMinute));

  app.get(PUBLIC_ROUTES.authLogin.express, async (_request, response, next) => {
    try {
      response.redirect(302, await auth.useCases.beginLogin());
    } catch (error) {
      next(error);
    }
  });

  // Login direto por usuário/senha (fluxo USER_PASSWORD_AUTH do Cognito, feito
  // no servidor). Emite a mesma sessão assinada das demais rotas e devolve o
  // ID token no corpo para clientes que precisem do JWT.
  app.post(
    PUBLIC_ROUTES.authPasswordLogin.express,
    async (request, response, next) => {
      try {
        const parsed = passwordLoginBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const { identity, tokens } = await auth.passwordLogin.login(
          parsed.data.username,
          parsed.data.password,
        );
        issueSession(response, identity);
        response.json(
          successEnvelope(
            {
              data: {
                token: tokens.idToken,
                tokenType: tokens.tokenType,
                expiresInSeconds: tokens.expiresInSeconds,
                user: {
                  id: identity.id,
                  name: identity.name,
                  email: identity.email,
                  role: identity.role,
                },
              },
              quality: {
                window: null,
                partial: false,
                refreshAfterSeconds: null,
                freshness: [],
                warnings: [],
              },
            },
            response.locals.requestId as string,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    PUBLIC_ROUTES.authCallback.express,
    async (request, response, next) => {
      try {
        const parsed = authCallbackQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        const identity = await auth.useCases.completeLogin(
          parsed.data.code,
          parsed.data.state,
        );
        issueSession(response, identity);
        response.redirect(302, "/visao-geral");
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(PUBLIC_ROUTES.authLogout.express, (_request, response) => {
    response.clearCookie("session", {
      httpOnly: true,
      secure: sessionCookieSecure,
      sameSite: "lax",
      path: "/",
    });
    response.status(204).end();
  });

  app.get(PUBLIC_ROUTES.authSession.express, (request, response, next) => {
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
    response.json(
      successEnvelope(
        {
          data: {
            authenticated: true,
            user: {
              id: identity.id,
              name: identity.name,
              email: identity.email,
            },
          },
          quality: {
            window: null,
            partial: false,
            refreshAfterSeconds: null,
            freshness: [],
            warnings: [],
          },
        },
        response.locals.requestId as string,
      ),
    );
  });

  app.get(
    PUBLIC_ROUTES.dashboardOverview.express,
    async (request, response, next) => {
      try {
        const parsed = overviewQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const result = await dashboard.overview(parsed.data);
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(PUBLIC_ROUTES.incidents.express, async (request, response, next) => {
    try {
      const parsed = incidentsQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const actor = auth.sessions.verify(
        parseCookie(request.header("cookie"), "session"),
      );
      if (!actor)
        throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
      const result = await incidents.list(parsed.data);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(PUBLIC_ROUTES.diagnosis.express, async (request, response, next) => {
    try {
      const incidentId = opaqueId(request.params.incidentId);
      const actor = auth.sessions.verify(
        parseCookie(request.header("cookie"), "session"),
      );
      if (!actor)
        throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
      const result = await incidents.diagnosis(incidentId);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(PUBLIC_ROUTES.events.express, async (request, response, next) => {
    try {
      const incidentId = opaqueId(request.params.incidentId);
      const parsed = eventsQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      const actor = auth.sessions.verify(
        parseCookie(request.header("cookie"), "session"),
      );
      if (!actor)
        throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
      const result = await incidents.events(incidentId, parsed.data.limit);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(PUBLIC_ROUTES.event.express, (request, response, next) => {
    try {
      opaqueId(request.params.incidentId);
      opaqueId(request.params.eventId);
      incidents.event();
    } catch (error) {
      next(error);
    }
  });

  app.patch(PUBLIC_ROUTES.review.express, async (request, response, next) => {
    try {
      const incidentId = opaqueId(request.params.incidentId);
      const hypothesisId = opaqueId(request.params.hypothesisId);
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
      metrics.observeHypothesisReview(parsed.data.status);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post(
    PUBLIC_ROUTES.reanalyze.express,
    express.raw({
      type: (request) => {
        const contentLength = request.headers["content-length"] ?? "0";
        return (
          Number(contentLength) > 0 ||
          request.headers["transfer-encoding"] !== undefined
        );
      },
      limit: "64kb",
    }),
    async (request, response, next) => {
      try {
        const body = z.undefined().safeParse(request.body);
        if (!body.success) throw validationError(body.error);
        const idempotencyKey = idempotencyKeySchema.safeParse(
          request.header("idempotency-key"),
        );
        if (!idempotencyKey.success)
          throw validationError(idempotencyKey.error);
        const incidentId = opaqueIdSchema.safeParse(request.params.incidentId);
        if (!incidentId.success) throw validationError(incidentId.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        await incidents.reanalyze(
          incidentId.data,
          idempotencyKey.data,
          actor.id,
        );
        response.status(202).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    PUBLIC_ROUTES.monitoringOverview.express,
    async (request, response, next) => {
      try {
        const parsed = monitoringQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const result = await dashboard.monitoring(parsed.data);
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    PUBLIC_ROUTES.importStart.express,
    async (request, _response, next) => {
      try {
        const parsed = startImportBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        await imports.start({ ...parsed.data, requestedBy: actor.id });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    PUBLIC_ROUTES.importComplete.express,
    async (request, _response, next) => {
      try {
        const importId = opaqueIdSchema.safeParse(request.params.importId);
        if (!importId.success) throw validationError(importId.error);
        const parsed = completeImportBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        await imports.complete({
          importId: importId.data,
          parts: parsed.data.parts,
          requestedBy: actor.id,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    PUBLIC_ROUTES.importStatus.express,
    async (request, _response, next) => {
      try {
        const importId = opaqueIdSchema.safeParse(request.params.importId);
        if (!importId.success) throw validationError(importId.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        await imports.get(importId.data, actor.id);
      } catch (error) {
        next(error);
      }
    },
  );

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
      const malformedJson = isMalformedJson(error);
      const malformedPathParameter = isMalformedPathParameter(error);
      const serviceError =
        error instanceof ServiceError
          ? error
          : malformedJson
            ? new ServiceError(
                400,
                "VALIDATION_ERROR",
                "O corpo JSON da requisição é inválido.",
                [
                  {
                    field: "body",
                    code: "invalid_json",
                    message: "O corpo deve conter JSON válido.",
                  },
                ],
              )
            : malformedPathParameter
              ? new ServiceError(
                  400,
                  "VALIDATION_ERROR",
                  "Um ou mais parâmetros são inválidos.",
                  [
                    {
                      field: "path",
                      code: "invalid_uri",
                      message: "A rota contém codificação inválida.",
                    },
                  ],
                )
              : new ServiceError(
                  500,
                  "INTERNAL_ERROR",
                  "Falha interna na API.",
                );
      if (
        !(error instanceof ServiceError) &&
        !malformedJson &&
        !malformedPathParameter
      ) {
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          if (error instanceof Error) activeSpan.recordException(error);
          activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
        logger.error("unhandled request error", {
          request_id: response.locals.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      response
        .status(serviceError.status)
        .json(errorEnvelope(serviceError, response.locals.requestId as string));
    },
  );
  return app;
}

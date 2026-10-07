import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { z } from "zod";
import {
  ServiceError,
  activateImportBodySchema,
  argusLiveSyncUpdateSchema,
  assertNoPhysicalFields,
  authCallbackQuerySchema,
  completeImportBodySchema,
  importIdSchema,
  importsQuerySchema,
  signImportPartsBodySchema,
  restartImportBodySchema,
  createLogger,
  errorEnvelope,
  eventsQuerySchema,
  idempotencyKeySchema,
  incidentsQuerySchema,
  monitoringQuerySchema,
  opaqueIdSchema,
  overviewQuerySchema,
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
import type { ArgusLiveSyncUseCases } from "./modules/argus/index.js";
import type { ImportControlPort } from "./modules/imports/index.js";
import {
  recordRequestFailure,
  requestObservability,
} from "./observability/http-observability.js";
import { Metrics, type LoginOutcome } from "./observability/metrics.js";
import { PUBLIC_ROUTES } from "./http/public-routes.js";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "view-show-api";
const logger = createLogger(SERVICE_NAME);

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly incidents: IncidentUseCases;
  readonly dashboard: DashboardQueries;
  readonly argus: ArgusLiveSyncUseCases;
  readonly imports: ImportControlPort;
  readonly auth: AuthModule;
}

/** Resultado da tentativa de login a partir do erro já traduzido pelo caso de uso. */
function loginOutcome(error: unknown): LoginOutcome {
  if (!(error instanceof ServiceError)) return "error";
  switch (error.code) {
    case "UNAUTHENTICATED":
      return "invalid_credentials";
    case "FORBIDDEN":
      return "blocked";
    case "RATE_LIMITED":
      return "rate_limited";
    case "FEATURE_UNAVAILABLE":
      return "unavailable";
    default:
      return "error";
  }
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

function isPayloadTooLarge(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const parserError = error as Error & { status?: unknown; type?: unknown };
  return parserError.status === 413 && parserError.type === "entity.too.large";
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
  const { config, incidents, dashboard, imports, argus, auth } = deps;
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
  app.use(requestObservability(logger));
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
        // Contexto W3C: permite ao painel continuar o trace na API.
        "traceparent",
        "tracestate",
      ],
      exposedHeaders: ["X-Request-Id", "X-Trace-Id"],
    }),
  );
  // A 10 GiB ZIP has 640 parts. At 1024 ETag characters with six-byte JSON
  // escapes, the complete canonical manifest is 3,991,583 bytes (< 4 MiB).
  // Parse it first; express.json skips the consumed body in the global parser.
  app.post(
    PUBLIC_ROUTES.importComplete.express,
    express.json({ limit: 4 * 1024 * 1024 }),
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
  const loginRateLimiter = rateLimiter(config.authLoginRateLimitPerMinute);

  app.get(PUBLIC_ROUTES.authLogin.express, async (_request, response, next) => {
    try {
      response.redirect(302, await auth.useCases.beginLogin());
    } catch (error) {
      next(error);
    }
  });

  // Login direto por usuário/senha (fluxo USER_PASSWORD_AUTH do Cognito,
  // feito no servidor). Emite a mesma sessão assinada das demais rotas; o
  // navegador não recebe o ID/access token do Cognito, só o cookie
  // HttpOnly — um token no corpo da resposta seria alcançável por JS
  // (inclusive por um XSS) sem que o cliente precise dele para nada.
  // `loginRateLimiter` soma-se ao limite geral: esta rota é alvo natural de
  // força bruta, e o throttling do próprio Cognito só entra depois do
  // round-trip até a AWS.
  app.post(
    PUBLIC_ROUTES.authPasswordLogin.express,
    loginRateLimiter,
    async (request, response, next) => {
      try {
        const parsed = passwordLoginBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const { identity } = await auth.passwordLogin.login(
          parsed.data.username,
          parsed.data.password,
        );
        metrics.observeLogin("success");
        issueSession(response, identity);
        response.json(
          successEnvelope(
            {
              data: {
                user: {
                  id: identity.id,
                  name: identity.name,
                  email: identity.email,
                  role: identity.role,
                },
              },
              datasetVersion: null,
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
        // Só falhas do provedor/credencial contam; o corpo inválido (400) já
        // aparece em http_requests_total e não é tentativa de autenticação.
        if (!(error instanceof ServiceError) || error.status !== 400)
          metrics.observeLogin(loginOutcome(error));
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
    const session = auth.sessions.verifyWithIssuedAt(
      parseCookie(request.header("cookie"), "session"),
    );
    if (!session)
      return next(
        new ServiceError(
          401,
          "UNAUTHENTICATED",
          "Sessão inválida, ausente ou expirada.",
        ),
      );
    const { identity, issuedAt } = session;
    response.json(
      successEnvelope(
        {
          data: {
            authenticated: true,
            user: {
              id: identity.id,
              name: identity.name,
              email: identity.email,
              role: identity.role,
              issuedAt: new Date(issuedAt * 1000).toISOString(),
            },
          },
          datasetVersion: null,
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
    PUBLIC_ROUTES.argusIntegration.express,
    async (request, response, next) => {
      try {
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        response.json(
          successEnvelope(
            await argus.get(),
            response.locals.requestId as string,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    PUBLIC_ROUTES.argusIntegrationUpdate.express,
    async (request, response, next) => {
      try {
        const parsed = argusLiveSyncUpdateSchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const integration = await argus.set(parsed.data.enabled);
        logger.info("argus live sync updated", {
          event: "argus.live_sync.updated",
          enabled: parsed.data.enabled,
          updated_by: actor.id,
        });
        response.json(
          successEnvelope(integration, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    PUBLIC_ROUTES.dashboardOverview.express,
    async (request, response, next) => {
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
    },
  );

  app.get(PUBLIC_ROUTES.incidents.express, async (request, response, next) => {
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

  app.get(PUBLIC_ROUTES.diagnosis.express, async (request, response, next) => {
    try {
      const incidentId = opaqueId(request.params.incidentId);
      const result = await incidents.diagnosis(incidentId);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(
    PUBLIC_ROUTES.globalEvents.express,
    async (request, response, next) => {
      try {
        const parsed = eventsQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const result = await incidents.globalEvents(parsed.data);
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
    PUBLIC_ROUTES.globalEvent.express,
    async (request, response, next) => {
      try {
        const eventId = opaqueId(request.params.eventId);
        const actor = auth.sessions.verify(
          parseCookie(request.header("cookie"), "session"),
        );
        if (!actor)
          throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
        const result = await incidents.globalEvent(eventId);
        assertNoPhysicalFields(result.data);
        response.json(
          successEnvelope(result, response.locals.requestId as string),
        );
      } catch (error) {
        next(error);
      }
    },
  );

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
      const result = await incidents.events(incidentId, parsed.data);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get(PUBLIC_ROUTES.event.express, async (request, response, next) => {
    try {
      const incidentId = opaqueId(request.params.incidentId);
      const eventId = opaqueId(request.params.eventId);
      const actor = auth.sessions.verify(
        parseCookie(request.header("cookie"), "session"),
      );
      if (!actor)
        throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
      const result = await incidents.event(incidentId, eventId);
      assertNoPhysicalFields(result.data);
      response.json(
        successEnvelope(result, response.locals.requestId as string),
      );
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
      // Auditoria: a revisão humana é o único caminho de escrita no veredito.
      logger.info("hypothesis review submitted", {
        event: "hypothesis.review.submitted",
        incident_id: incidentId,
        hypothesis_id: hypothesisId,
        status: parsed.data.status,
        reviewer_id: actor.id,
      });
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
        logger.info("reanalysis requested", {
          event: "reanalysis.requested",
          incident_id: incidentId.data,
          requested_by: actor.id,
        });
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
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const parsed = startImportBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const result = await imports.start({
          ...parsed.data,
          requestedBy: actor.id,
          author: { id: actor.id, name: actor.name, email: actor.email },
          idempotencyKey: importIdempotencyKey(request),
        });
        response
          .status(201)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );

  function importActor(request: Request) {
    const actor = auth.sessions.verify(
      parseCookie(request.header("cookie"), "session"),
    );
    if (!actor)
      throw new ServiceError(401, "UNAUTHENTICATED", "Sessão inválida.");
    return actor;
  }
  function importIdempotencyKey(request: Request) {
    const parsed = idempotencyKeySchema.safeParse(
      request.header("idempotency-key"),
    );
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
  }
  function importIdentifier(request: Request) {
    const parsed = importIdSchema.safeParse(request.params.importId);
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
  }

  app.get(PUBLIC_ROUTES.importList.express, async (request, response, next) => {
    try {
      const actor = importActor(request);
      const query = importsQuerySchema.safeParse(request.query);
      if (!query.success) throw validationError(query.error);
      const result = await imports.list({
        ...query.data,
        requestedBy: actor.id,
      });
      response
        .status(200)
        .json(successEnvelope(result, response.locals.requestId as string));
    } catch (error) {
      next(error);
    }
  });
  app.get(
    PUBLIC_ROUTES.importParts.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const result = await imports.listParts(
          importIdentifier(request),
          actor.id,
        );
        response
          .status(200)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    PUBLIC_ROUTES.importSignParts.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const parsed = signImportPartsBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const result = await imports.signParts({
          importId: importIdentifier(request),
          requestedBy: actor.id,
          ...parsed.data,
        });
        response
          .status(200)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    PUBLIC_ROUTES.importActivate.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const body = activateImportBodySchema.safeParse(request.body);
        if (!body.success) throw validationError(body.error);
        const result = await imports.activate({
          importId: importIdentifier(request),
          requestedBy: actor.id,
          idempotencyKey: importIdempotencyKey(request),
        });
        response
          .status(200)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    PUBLIC_ROUTES.importRestart.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const parsed = restartImportBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const result = await imports.restart({
          importId: importIdentifier(request),
          requestedBy: actor.id,
          idempotencyKey: importIdempotencyKey(request),
        });
        response
          .status(202)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    PUBLIC_ROUTES.importComplete.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const importId = importIdentifier(request);
        const parsed = completeImportBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        const result = await imports.complete({
          importId,
          parts: parsed.data.parts,
          requestedBy: actor.id,
          idempotencyKey: importIdempotencyKey(request),
        });
        response
          .status(202)
          .json(successEnvelope(result, response.locals.requestId as string));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    PUBLIC_ROUTES.importStatus.express,
    async (request, response, next) => {
      try {
        const actor = importActor(request);
        const result = await imports.get(importIdentifier(request), actor.id);
        response
          .status(200)
          .json(successEnvelope(result, response.locals.requestId as string));
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
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const malformedJson = isMalformedJson(error);
      const payloadTooLarge = isPayloadTooLarge(error);
      const malformedPathParameter = isMalformedPathParameter(error);
      const serviceError =
        error instanceof ServiceError
          ? error
          : payloadTooLarge
            ? new ServiceError(
                413,
                "VALIDATION_ERROR",
                "O corpo da requisição excede o limite permitido.",
              )
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
      recordRequestFailure(
        logger,
        request,
        response,
        error,
        serviceError,
        (!(error instanceof ServiceError) &&
          !payloadTooLarge &&
          !malformedJson &&
          !malformedPathParameter) ||
          serviceError.status === 500,
      );
      response
        .status(serviceError.status)
        .json(errorEnvelope(serviceError, response.locals.requestId as string));
    },
  );
  return app;
}

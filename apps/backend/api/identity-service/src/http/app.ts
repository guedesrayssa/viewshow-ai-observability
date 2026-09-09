import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import {
  ServiceError,
  createLogger,
  errorEnvelope,
  requestId,
  validationError,
} from "@view-show/contracts";
import type { IdentityUseCases } from "../application/identity-use-cases.js";
import type { IdentityConfig } from "../config.js";
import { SessionCodec, parseCookie } from "../domain/session.js";

const loginSchema = z
  .object({ email: z.email(), password: z.string().min(1).max(1024) })
  .strict();
const logger = createLogger("identity-service");

export function createApp(
  useCases: IdentityUseCases,
  sessions: SessionCodec,
  config: IdentityConfig,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((request, response, next) => {
    response.locals.requestId = request.header("x-request-id") ?? requestId();
    response.setHeader("x-request-id", response.locals.requestId as string);
    next();
  });
  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "identity-service" }),
  );
  app.use("/internal/v1", (request, _response, next) => {
    if (request.header("x-internal-token") !== config.internalToken)
      return next(
        new ServiceError(403, "FORBIDDEN", "Chamada interna não autorizada."),
      );
    next();
  });

  app.post("/internal/v1/auth/login", async (request, response, next) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const identity = await useCases.login(
        parsed.data.email,
        parsed.data.password,
      );
      response.cookie("session", sessions.issue(identity), {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000,
        path: "/",
      });
      response.json({ status: "ok", name: identity.name, role: identity.role });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/v1/auth/logout", (_request, response) => {
    response.clearCookie("session", {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/",
    });
    response.status(204).end();
  });
  app.post("/internal/v1/auth/register", (_request, _response, next) =>
    next(useCases.unavailable("Cadastro local")),
  );
  app.post("/internal/v1/auth/recover", (_request, _response, next) =>
    next(useCases.unavailable("Recuperação de senha local")),
  );
  app.get("/internal/v1/auth/sso", (_request, _response, next) =>
    next(useCases.unavailable("SSO")),
  );

  app.get("/internal/v1/session", (request, response, next) => {
    const identity = sessions.verify(
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
              "Falha interna no serviço de identidade.",
            );
      if (!(error instanceof ServiceError))
        logger.error("unhandled request error", {
          error: error instanceof Error ? error.message : String(error),
        });
      response
        .status(serviceError.status)
        .json(errorEnvelope(serviceError, response.locals.requestId as string));
    },
  );
  return app;
}

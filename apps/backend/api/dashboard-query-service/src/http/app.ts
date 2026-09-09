import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  ServiceError,
  createLogger,
  errorEnvelope,
  monitoringQuerySchema,
  overviewQuerySchema,
  requestId,
  validationError,
} from "@view-show/contracts";
import type { DashboardQueries } from "../application/dashboard-queries.js";

const logger = createLogger("dashboard-query-service");

export function createApp(queries: DashboardQueries, internalToken: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.locals.requestId = request.header("x-request-id") ?? requestId();
    response.setHeader("x-request-id", response.locals.requestId as string);
    next();
  });
  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "dashboard-query-service" }),
  );
  app.use("/internal/v1", (request, _response, next) => {
    if (request.header("x-internal-token") !== internalToken)
      return next(
        new ServiceError(403, "FORBIDDEN", "Chamada interna não autorizada."),
      );
    next();
  });
  app.get(
    "/internal/v1/dashboard/overview",
    async (request, response, next) => {
      try {
        const parsed = overviewQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        response.json(await queries.overview(parsed.data));
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    "/internal/v1/monitoring/overview",
    async (request, response, next) => {
      try {
        const parsed = monitoringQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        response.json(await queries.monitoring(parsed.data));
      } catch (error) {
        next(error);
      }
    },
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
              "Falha interna no serviço de consultas.",
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

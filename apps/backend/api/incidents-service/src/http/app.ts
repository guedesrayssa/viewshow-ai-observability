import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  ServiceError,
  createLogger,
  errorEnvelope,
  eventsQuerySchema,
  incidentsQuerySchema,
  opaqueIdSchema,
  requestId,
  reviewBodySchema,
  validationError,
} from "@view-show/contracts";
import type { IncidentUseCases } from "../application/incident-use-cases.js";

const logger = createLogger("incidents-service");

export function createApp(useCases: IncidentUseCases, internalToken: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((request, response, next) => {
    response.locals.requestId = request.header("x-request-id") ?? requestId();
    response.setHeader("x-request-id", response.locals.requestId as string);
    next();
  });

  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "incidents-service" }),
  );

  app.use("/internal/v1", (request, _response, next) => {
    if (request.header("x-internal-token") !== internalToken)
      return next(
        new ServiceError(403, "FORBIDDEN", "Chamada interna não autorizada."),
      );
    next();
  });

  app.get("/internal/v1/incidents", async (request, response, next) => {
    try {
      const parsed = incidentsQuerySchema.safeParse(request.query);
      if (!parsed.success) throw validationError(parsed.error);
      response.json(await useCases.list(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/internal/v1/incidents/:incidentId/diagnosis",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        response.json(await useCases.diagnosis(incidentId));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/internal/v1/incidents/:incidentId/events",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const parsed = eventsQuerySchema.safeParse(request.query);
        if (!parsed.success) throw validationError(parsed.error);
        response.json(await useCases.events(incidentId, parsed.data.limit));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/internal/v1/incidents/:incidentId/events/:eventId",
    (request, response, next) => {
      try {
        opaqueIdSchema.parse(request.params.incidentId);
        opaqueIdSchema.parse(request.params.eventId);
        response.json(useCases.event());
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/internal/v1/incidents/:incidentId/hypotheses/:hypothesisId/review",
    async (request, response, next) => {
      try {
        const incidentId = opaqueIdSchema.parse(request.params.incidentId);
        const selectedHypothesisId = opaqueIdSchema.parse(
          request.params.hypothesisId,
        );
        const reviewerId = request.header("x-reviewer-id");
        if (!reviewerId)
          throw new ServiceError(
            401,
            "UNAUTHENTICATED",
            "A identidade do revisor não foi propagada.",
          );
        const parsed = reviewBodySchema.safeParse(request.body);
        if (!parsed.success) throw validationError(parsed.error);
        response.json(
          await useCases.review(
            incidentId,
            selectedHypothesisId,
            parsed.data,
            reviewerId,
          ),
        );
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
              "Falha interna no serviço de incidentes.",
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

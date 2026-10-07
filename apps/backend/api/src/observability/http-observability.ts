import type { Request, RequestHandler, Response } from "express";
import { trace } from "@opentelemetry/api";
import {
  type ServiceError,
  activeTraceId,
  recordSpanError,
  requestId,
  runWithLogContext,
  serializeError,
  type Logger,
} from "@view-show/contracts";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Requisições mais lentas que isto saem em `warn` (RNF14: p95 até 2 s). */
const DEFAULT_SLOW_REQUEST_MS = 2_000;

function slowRequestThresholdMs(): number {
  const configured = Number(process.env.SLOW_REQUEST_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SLOW_REQUEST_MS;
}

/** Aceita o `X-Request-Id` do cliente se for seguro; senão gera um. */
export function requestIdentifier(request: Request): string {
  const candidate = request.header("x-request-id");
  return candidate && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : requestId();
}

/** Template da rota casada (`/api/v1/incidents/:incidentId/events`). */
export function routeTemplate(request: Request): string | undefined {
  const path = request.route?.path;
  return typeof path === "string" ? `${request.baseUrl}${path}` : undefined;
}

/** Sondas do ALB e do Prometheus: alto volume, nenhum valor em log. */
function isOperationalProbe(request: Request): boolean {
  return request.path === "/health" || request.path === "/metrics";
}

function accessLevel(status: number, slow: boolean): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  return status >= 400 || slow ? "warn" : "info";
}

/**
 * Primeiro middleware da API. Para cada requisição:
 *  - define o `request_id` (resposta, contexto de log e atributo do span);
 *  - devolve `x-trace-id`, para ir de uma resposta ao trace no Grafana;
 *  - emite UMA linha de acesso ao final, com nível conforme o status.
 */
export function requestObservability(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const id = requestIdentifier(request);
    response.locals.requestId = id;
    response.setHeader("x-request-id", id);
    const traceId = activeTraceId();
    if (traceId) response.setHeader("x-trace-id", traceId);
    trace.getActiveSpan()?.setAttribute("viewshow.request_id", id);

    const started = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
    let finished = false;

    response.once("finish", () => {
      finished = true;
      const status = response.statusCode;
      if (isOperationalProbe(request) && status < 500) return;
      const durationMs = elapsedMs();
      const slow = durationMs >= slowRequestThresholdMs();
      const route = routeTemplate(request);
      const contentLength = Number(response.getHeader("content-length"));
      const errorCode = response.locals.errorCode;
      logger[accessLevel(status, slow)]("request completed", {
        event: "http.request.completed",
        request_id: id,
        method: request.method,
        route: route ?? "unmatched",
        ...(route ? {} : { path: request.path.slice(0, 200) }),
        status,
        duration_ms: Math.round(durationMs * 100) / 100,
        ...(slow ? { slow: true } : {}),
        ...(Number.isFinite(contentLength)
          ? { response_bytes: contentLength }
          : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
      });
    });
    // O cliente desistiu (timeout do painel, k6, aba fechada) antes da resposta.
    response.once("close", () => {
      if (finished) return;
      logger.warn("request aborted by client", {
        event: "http.request.aborted",
        request_id: id,
        method: request.method,
        route: routeTemplate(request) ?? "unmatched",
        duration_ms: Math.round(elapsedMs() * 100) / 100,
      });
    });
    runWithLogContext({ request_id: id }, next);
  };
}

/**
 * Registra no log e no span a falha que virou resposta de erro.
 *
 * - O código de negócio (`error_code`) vai sempre ao span e à linha de acesso.
 * - O detalhe com a pilha só é emitido quando `unexpected` (bug ou falha de
 *   dependência que virou 500); os 503 deliberados (`DATA_UNAVAILABLE`,
 *   `FEATURE_UNAVAILABLE`) e os 4xx já ficam descritos pela linha de acesso,
 *   sem duplicar a linha de erro.
 */
export function recordRequestFailure(
  logger: Logger,
  request: Request,
  response: Response,
  error: unknown,
  outcome: ServiceError,
  unexpected: boolean,
): void {
  response.locals.errorCode = outcome.code;
  if (!unexpected) return;
  const span = trace.getActiveSpan();
  if (span) recordSpanError(span, error);
  logger.error("unhandled request error", {
    event: "http.request.failed",
    request_id: response.locals.requestId,
    method: request.method,
    route: routeTemplate(request) ?? "unmatched",
    error: serializeError(error, { includeStack: true }),
  });
}

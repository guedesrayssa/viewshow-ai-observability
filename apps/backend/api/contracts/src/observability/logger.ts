import { trace } from "@opentelemetry/api";
import { getLogContext } from "./log-context.js";
import { getLokiTransport } from "./loki-transport.js";
import { sanitizeFields } from "./redaction.js";
import { resolveServiceMetadata } from "./service-metadata.js";

export interface Logger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

type LogLevel = "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { info: 30, warn: 40, error: 50 };

/** Campos que o chamador não pode forjar: pertencem ao logger. */
const RESERVED_FIELDS = [
  "timestamp",
  "level",
  "service_name",
  "environment",
  "service_version",
  "trace_id",
  "span_id",
  "message",
] as const;

/** `LOG_LEVEL`: info (padrão), warn, error ou silent. Lido a cada linha. */
function minimumSeverity(): number {
  switch (process.env.LOG_LEVEL?.trim().toLowerCase()) {
    case "warn":
      return SEVERITY.warn;
    case "error":
      return SEVERITY.error;
    case "silent":
      return Number.POSITIVE_INFINITY;
    default:
      return SEVERITY.info;
  }
}

/**
 * Logger de uma linha JSON por evento, em `stdout`.
 *
 * Cada linha carrega `service_name`, `environment`, `service_version` e, quando
 * há span ativo, `trace_id`/`span_id` (é o que o Grafana usa para saltar do log
 * ao trace). Campos do contexto de requisição (`request_id`) entram sozinhos.
 * Os campos do chamador passam pela redação antes de serem serializados.
 */
export function createLogger(serviceName: string): Logger {
  const write = (
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (SEVERITY[level] < minimumSeverity()) return;
    const metadata = resolveServiceMetadata(serviceName);
    const spanContext = trace.getActiveSpan()?.spanContext();
    const sanitized = sanitizeFields({ ...getLogContext(), ...fields });
    for (const reserved of RESERVED_FIELDS) delete sanitized[reserved];
    const now = Date.now();
    const line = JSON.stringify({
      ...sanitized,
      timestamp: new Date(now).toISOString(),
      level,
      service_name: metadata.serviceName,
      environment: metadata.environment,
      service_version: metadata.version,
      ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
      ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
      message,
    });
    process.stdout.write(`${line}\n`);
    getLokiTransport()?.enqueue(
      {
        service_name: metadata.serviceName,
        level,
        environment: metadata.environment,
      },
      line,
      now,
    );
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

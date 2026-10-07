import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { serializeError } from "./redaction.js";

const TRACER_NAME = "view-show-api";

/**
 * Registra a falha no span com mensagem e pilha já sanitizadas. O evento de
 * exceção do OpenTelemetry carrega o texto do erro como veio do SDK da AWS ou
 * do Zod, então passa pela mesma redação dos logs antes de ir ao Tempo.
 */
export function recordSpanError(span: Span, error: unknown): void {
  const safe = serializeError(error, { includeStack: true });
  span.recordException({
    name: safe.type,
    message: safe.message,
    ...(safe.stack ? { stack: safe.stack } : {}),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: safe.message });
  span.setAttribute("error.type", safe.type);
  if (safe.code) span.setAttribute("viewshow.error_code", safe.code);
}

/**
 * Executa `operation` dentro de um span interno ativo. Os spans dos SDKs da
 * AWS criados lá dentro viram filhos dele. Use para operações de negócio que
 * não têm um span automático próprio (tarefas em segundo plano, por exemplo).
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await operation(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
}

/** Acrescenta atributos ao span ativo; sem span ativo, não faz nada. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** Identificador do trace ativo (32 hex), ou `undefined` se não houver. */
export function activeTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  return context && trace.isSpanContextValid(context)
    ? context.traceId
    : undefined;
}

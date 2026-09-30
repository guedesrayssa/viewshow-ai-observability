import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { LlmResponse } from "../ports/llm-provider.js";
import type { Delivery, Telemetry } from "../worker/types.js";

export type AnalysisStatus = "success" | "failure" | "retry" | "throttled";
export type LlmStatus = "success" | "failure";

export interface LlmIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export interface AgenticTelemetry {
  readonly event: Telemetry;
  runMessage<T>(
    delivery: Pick<Delivery, "id" | "receives">,
    operation: () => Promise<T>,
  ): Promise<T>;
  traceLlm(
    identity: LlmIdentity,
    operation: () => Promise<LlmResponse>,
  ): Promise<LlmResponse>;
  forceFlush(timeoutMs?: number): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface TelemetryConfig {
  readonly serviceName: string;
  readonly deploymentEnvironment: string;
  readonly serviceVersion: string;
  readonly otlpEndpoint?: string;
}

export interface TelemetryDependencies {
  readonly spanExporter?: SpanExporter;
  readonly metricReader?: MetricReader;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const KNOWN_EVENT_TYPES = new Set([
  "ANOMALY_DETECTION",
  "QOE_FORECAST",
  "REANALYSIS_REQUESTED",
]);

interface AnalysisRunState {
  eventType: string;
  status: AnalysisStatus;
  readonly span: Span;
}

function configuredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function parseOtlpEndpoint(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  try {
    const endpoint = new URL(normalized);
    const validProtocol = endpoint.protocol === "http:" || endpoint.protocol === "https:";
    const hasCredentials = endpoint.username !== "" || endpoint.password !== "";
    const hasQueryOrFragment = endpoint.search !== "" || endpoint.hash !== "";
    if (!validProtocol || hasCredentials || hasQueryOrFragment) throw new Error("unsafe");
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT inválido");
  }
}

function stableErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  const constructorName = typeof error === "object" && error !== null
    ? error.constructor?.name
    : undefined;
  const sanitized = (constructorName || "Error")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 64);
  return sanitized || "Error";
}

export function telemetryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig {
  const otlpEndpoint = parseOtlpEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const base = {
    serviceName: configuredValue(env.OTEL_SERVICE_NAME, "view-show-agentic"),
    deploymentEnvironment: configuredValue(
      env.OTEL_DEPLOYMENT_ENVIRONMENT,
      "local",
    ),
    serviceVersion: configuredValue(env.OTEL_SERVICE_VERSION, "development"),
  };
  return otlpEndpoint ? { ...base, otlpEndpoint } : base;
}

export function createAgenticTelemetry(
  config: TelemetryConfig,
  dependencies: TelemetryDependencies = {},
): AgenticTelemetry {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.deploymentEnvironment,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
  });

  const spanExporter = dependencies.spanExporter ?? (
    config.otlpEndpoint
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` })
      : undefined
  );
  const metricReader = dependencies.metricReader ?? (
    config.otlpEndpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${config.otlpEndpoint}/v1/metrics`,
          }),
        })
      : undefined
  );

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: spanExporter ? [new BatchSpanProcessor(spanExporter)] : [],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: metricReader ? [metricReader] : [],
  });
  const tracer = tracerProvider.getTracer(config.serviceName, config.serviceVersion);
  const meter = meterProvider.getMeter(config.serviceName, config.serviceVersion);
  const messageCount = meter.createCounter("analysis_messages_total", {
    description: "Analysis messages finalized by event type and logical status.",
  });
  const messageDuration = meter.createHistogram("analysis_run_duration_seconds", {
    description: "Analysis message processing duration.",
    unit: "s",
  });
  const llmRequests = meter.createCounter("llm_requests_total", {
    description: "LLM requests by provider, model and outcome.",
  });
  const llmDuration = meter.createHistogram("llm_request_duration_seconds", {
    description: "LLM request duration.",
    unit: "s",
  });
  const llmTokens = meter.createCounter("llm_tokens_total", {
    description: "LLM tokens reported by the provider.",
  });
  const llmStops = meter.createCounter("llm_response_stop_total", {
    description: "LLM responses by normalized stop reason.",
  });
  const runs = new AsyncLocalStorage<AnalysisRunState>();
  const now = dependencies.now ?? (() => performance.now());

  const write = dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const event: Telemetry = (name, fields) => {
    const run = runs.getStore();
    const candidateEventType = fields.eventType;
    if (run && typeof candidateEventType === "string") {
      run.eventType = KNOWN_EVENT_TYPES.has(candidateEventType)
        ? candidateEventType
        : "unknown";
    }
    if (run) {
      if (name === "analysis_completed") run.status = "success";
      if (name === "analysis_deferred") run.status = "retry";
      if (name === "analysis_failed") {
        run.status = fields.terminal === true ? "failure" : "retry";
      }
    }

    try {
      const spanContext = run?.span.spanContext();
      write(JSON.stringify({
        ...fields,
        event: name,
        ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
        ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
      }));
    } catch {
      // Observability must never alter the business operation outcome.
    }
  };

  let shutdownPromise: Promise<void> | undefined;

  return {
    event,
    async runMessage<T>(
      delivery: Pick<Delivery, "id" | "receives">,
      operation: () => Promise<T>,
    ): Promise<T> {
      const startedAt = now();
      const span = tracer.startSpan("analysis.message", {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "sqs",
          "messaging.message.id": delivery.id,
          "viewshow.retry_count": Math.max(delivery.receives - 1, 0),
        },
      });
      const run: AnalysisRunState = {
        eventType: "unknown",
        status: "failure",
        span,
      };

      try {
        const spanContext = trace.setSpan(context.active(), span);
        return await runs.run(run, () => context.with(spanContext, operation));
      } finally {
        const durationSeconds = Math.max(now() - startedAt, 0) / 1_000;
        const labels = { event_type: run.eventType, status: run.status };
        messageCount.add(1, labels);
        messageDuration.record(durationSeconds, labels);
        span.setAttributes({
          "viewshow.event_type": run.eventType,
          "viewshow.analysis_status": run.status,
        });
        span.setStatus({
          code: run.status === "failure" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
      }
    },
    async traceLlm(
      identity: LlmIdentity,
      operation: () => Promise<LlmResponse>,
    ): Promise<LlmResponse> {
      const startedAt = now();
      const analysisSpan = runs.getStore()?.span;
      const parentContext = analysisSpan
        ? trace.setSpan(context.active(), analysisSpan)
        : context.active();
      const span = tracer.startSpan("llm.generate", {
        attributes: {
          "gen_ai.system": identity.provider,
          "gen_ai.request.model": identity.modelId,
        },
      }, parentContext);
      let status: LlmStatus = "failure";
      let stopReason: LlmResponse["stopReason"] | "error" = "error";

      try {
        const response = await context.with(trace.setSpan(parentContext, span), operation);
        stopReason = response.stopReason;
        status = stopReason === "stop" ? "success" : "failure";
        span.setAttributes({
          "gen_ai.response.finish_reasons": [stopReason],
          "llm.status": status,
        });
        span.setStatus({
          code: status === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });

        const inputTokens = response.usage?.inputTokens;
        if (typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0) {
          llmTokens.add(inputTokens, {
            provider: identity.provider,
            model_id: identity.modelId,
            token_type: "input",
          });
        }
        const outputTokens = response.usage?.outputTokens;
        if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
          llmTokens.add(outputTokens, {
            provider: identity.provider,
            model_id: identity.modelId,
            token_type: "output",
          });
        }
        return response;
      } catch (error) {
        span.setAttributes({
          "gen_ai.response.finish_reasons": ["error"],
          "llm.status": "failure",
          "error.type": stableErrorType(error),
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        const requestLabels = {
          provider: identity.provider,
          model_id: identity.modelId,
          status,
        };
        llmRequests.add(1, { ...requestLabels, stop_reason: stopReason });
        llmDuration.record(Math.max(now() - startedAt, 0) / 1_000, requestLabels);
        llmStops.add(1, {
          provider: identity.provider,
          model_id: identity.modelId,
          stop_reason: stopReason,
        });
        span.end();
      }
    },
    async forceFlush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
      try {
        await Promise.all([
          tracerProvider.forceFlush({ timeoutMillis: timeoutMs }),
          meterProvider.forceFlush({ timeoutMillis: timeoutMs }),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          const error = new Error("Telemetry shutdown failed") as Error & { code: string };
          error.code = "TELEMETRY_SHUTDOWN_FAILED";
          throw error;
        }
      });
      return shutdownPromise;
    },
  };
}

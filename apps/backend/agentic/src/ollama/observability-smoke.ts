import { createOllamaProvider } from "../adapters/llm/ollama-provider.js";
import {
  createAgenticTelemetry,
  telemetryConfigFromEnv,
  type TelemetryConfig,
} from "../observability/agentic-telemetry.js";
import { instrumentLlmProvider } from "../observability/instrumented-llm-provider.js";
import { checkOllamaConnectivity } from "./connectivity-check.js";

export async function runOllamaObservabilitySmoke(options: {
  baseUrl: string;
  modelId: string;
  otlpEndpoint?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  await checkOllamaConnectivity({
    baseUrl: options.baseUrl,
    modelId: options.modelId,
    timeoutMs: 10_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const config = ollamaSmokeTelemetryConfig(options.otlpEndpoint, process.env);
  const telemetry = createAgenticTelemetry(config);
  const rawProvider = createOllamaProvider({
    baseUrl: options.baseUrl,
    model: options.modelId,
    maxTokens: 32,
    timeoutMs: 30_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const provider = instrumentLlmProvider(rawProvider, telemetry, {
    provider: "ollama",
    modelId: options.modelId,
  });

  try {
    await telemetry.runMessage({
      id: "ollama-observability-smoke",
      receives: 1,
    }, async () => {
      const generated = await provider.generate({
        systemPrompt: "PROMPT_SMOKE_SENTINEL: responda somente JSON.",
        userPrompt: "Retorne exatamente {\"sentinel\":\"RESPONSE_SMOKE_SENTINEL\"}.",
      });
      if (generated.stopReason !== "stop") throw new Error("OLLAMA_SMOKE_INCOMPLETE");
      if (!generated.text.includes("RESPONSE_SMOKE_SENTINEL")) {
        throw new Error("OLLAMA_SMOKE_RESPONSE_SENTINEL_MISSING");
      }
      telemetry.event("ollama_observability_smoke", {
        modelId: options.modelId,
        status: "success",
      });
      telemetry.event("analysis_completed", { smoke: true });
      return generated;
    });
    if (!await telemetry.forceFlush(10_000)) throw new Error("OTEL_FLUSH_FAILED");
  } finally {
    await telemetry.shutdown();
  }
}

export function ollamaSmokeTelemetryConfig(
  otlpEndpoint: string | undefined,
  env: NodeJS.ProcessEnv,
): TelemetryConfig {
  return telemetryConfigFromEnv({
    ...env,
    ...(otlpEndpoint === undefined
      ? { OTEL_EXPORTER_OTLP_ENDPOINT: undefined }
      : { OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint }),
  });
}

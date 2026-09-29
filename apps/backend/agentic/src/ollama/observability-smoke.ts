import { createOllamaProvider } from "../adapters/llm/ollama-provider.js";
import {
  createAgenticTelemetry,
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
  const baseConfig = {
    serviceName: "view-show-agentic-smoke",
    deploymentEnvironment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "local",
    serviceVersion: process.env.OTEL_SERVICE_VERSION ?? "development",
  };
  const config: TelemetryConfig = options.otlpEndpoint
    ? { ...baseConfig, otlpEndpoint: options.otlpEndpoint.replace(/\/$/, "") }
    : baseConfig;
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
    const response = await provider.generate({
      systemPrompt: "PROMPT_SMOKE_SENTINEL: responda somente JSON.",
      userPrompt: "Retorne um objeto JSON vazio.",
    });
    if (response.stopReason !== "stop") throw new Error("OLLAMA_SMOKE_INCOMPLETE");
    telemetry.event("ollama_observability_smoke", {
      modelId: options.modelId,
      status: "success",
    });
    if (!await telemetry.forceFlush(10_000)) throw new Error("OTEL_FLUSH_FAILED");
  } finally {
    await telemetry.shutdown();
  }
}

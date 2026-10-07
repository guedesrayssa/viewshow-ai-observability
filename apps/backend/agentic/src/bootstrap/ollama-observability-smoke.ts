import { runOllamaObservabilitySmoke } from "../ollama/observability-smoke.js";
import { safeErrorType } from "./worker-runtime.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MissingEnvironment:${name}`);
  return value;
}

export async function main(): Promise<void> {
  await runOllamaObservabilitySmoke({
    baseUrl: required("OLLAMA_BASE_URL"),
    modelId: required("LLM_MODEL_ID"),
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ollama_observability_smoke_failed",
      errorType: safeErrorType(error),
    })}\n`);
    process.exitCode = 1;
  });
}

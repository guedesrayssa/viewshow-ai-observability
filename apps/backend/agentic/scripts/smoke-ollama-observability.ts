import { runOllamaObservabilitySmoke } from "../src/ollama/observability-smoke.js";
import { safeErrorType } from "../src/bootstrap/worker-runtime.js";

const baseUrl = process.env.OLLAMA_BASE_URL;
const modelId = process.env.LLM_MODEL_ID;
if (!baseUrl || !modelId) {
  process.stderr.write(`${JSON.stringify({
    event: "ollama_observability_smoke_failed",
    errorType: "MissingEnvironment",
  })}\n`);
  process.exitCode = 1;
} else {
  runOllamaObservabilitySmoke({
    baseUrl,
    modelId,
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ollama_observability_smoke_failed",
      errorType: safeErrorType(error),
    })}\n`);
    process.exitCode = 1;
  });
}

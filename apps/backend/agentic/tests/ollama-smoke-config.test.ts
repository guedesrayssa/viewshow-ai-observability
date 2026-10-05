import assert from "node:assert/strict";
import { test } from "node:test";
import { ollamaSmokeTelemetryConfig } from "../src/ollama/observability-smoke.js";

test("smoke uses the same service identity and validated OTLP parser as the worker", () => {
  assert.deepEqual(ollamaSmokeTelemetryConfig("http://10.0.0.5:4320/", {
    OTEL_SERVICE_NAME: "view-show-agentic",
    OTEL_DEPLOYMENT_ENVIRONMENT: "aws",
    OTEL_SERVICE_VERSION: "abc123",
  }), {
    serviceName: "view-show-agentic",
    deploymentEnvironment: "aws",
    serviceVersion: "abc123",
    otlpEndpoint: "http://10.0.0.5:4320",
  });
  assert.throws(
    () => ollamaSmokeTelemetryConfig("http://user:secret@10.0.0.5:4320", {}),
    /OTEL_EXPORTER_OTLP_ENDPOINT inválido/,
  );
});

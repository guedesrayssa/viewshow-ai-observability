import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgenticTelemetry,
  telemetryConfigFromEnv,
} from "../src/observability/agentic-telemetry.js";

test("uses the required defaults when OTLP is absent", () => {
  assert.deepEqual(telemetryConfigFromEnv({}), {
    serviceName: "view-show-agentic",
    deploymentEnvironment: "local",
    serviceVersion: "development",
  });
});

test("accepts one OTLP base endpoint without a trailing slash", () => {
  assert.equal(
    telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4320/" })
      .otlpEndpoint,
    "http://localhost:4320",
  );
});

test("treats an empty OTLP endpoint as disabled", () => {
  assert.equal(
    telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).otlpEndpoint,
    undefined,
  );
});

test("rejects unsafe or malformed OTLP endpoints without exposing credentials", () => {
  const invalidEndpoints = [
    "http://user:secret@localhost:4320",
    "file:///tmp/collector",
    "http://localhost:4320?token=secret",
    "http://localhost:4320/#secret",
    "not-a-url",
  ];

  for (const endpoint of invalidEndpoints) {
    assert.throws(
      () => telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /OTEL_EXPORTER_OTLP_ENDPOINT inválido/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
});

test("keeps telemetry functional without an OTLP network endpoint", async () => {
  const lines: string[] = [];
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    write: (line) => lines.push(line),
  });

  telemetry.event("analysis.received", { receives: 1, accepted: true });

  const runResult = await telemetry.runMessage(
    { id: "message-1", receives: 1 },
    async () => "processed",
  );
  const llmResult = await telemetry.traceLlm(
    { provider: "ollama", modelId: "qwen2.5:7b" },
    async () => ({
      text: "{}",
      provider: "ollama",
      modelId: "qwen2.5:7b",
      stopReason: "stop",
    }),
  );

  assert.equal(runResult, "processed");
  assert.equal(llmResult.provider, "ollama");
  assert.equal(await telemetry.forceFlush(100), true);
  await telemetry.shutdown();

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
    event: "analysis.received",
    receives: 1,
    accepted: true,
  });
});

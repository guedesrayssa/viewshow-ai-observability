import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MetricReader,
  type CollectionResult,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LlmProvider, LlmResponse } from "../src/ports/llm-provider.js";
import {
  createAgenticTelemetry,
  telemetryConfigFromEnv,
} from "../src/observability/agentic-telemetry.js";
import { instrumentLlmProvider } from "../src/observability/instrumented-llm-provider.js";

class InMemoryMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  snapshot(): Promise<CollectionResult> { return this.collect(); }
}

function findMetric(result: CollectionResult, name: string): MetricData | undefined {
  return result.resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
}

const request = { systemPrompt: "SYSTEM_SENTINEL", userPrompt: "USER_SENTINEL" };
const identity = { provider: "ollama", modelId: "qwen2.5:7b" };

test("returns the same successful response and records tokens in a child span", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricReader();
  const lines: string[] = [];
  let now = 10_000;
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    metricReader: metrics,
    now: () => now,
    write: (line) => lines.push(line),
  });
  const response: LlmResponse = {
    text: "RESPONSE_SENTINEL",
    provider: "ollama",
    modelId: "qwen2.5:7b",
    stopReason: "stop",
    usage: { inputTokens: 120, outputTokens: 45 },
  };
  const provider: LlmProvider = { generate: async () => { now = 10_300; return response; } };
  const instrumented = instrumentLlmProvider(provider, telemetry, identity);

  const returned = await telemetry.runMessage({ id: "message-1", receives: 1 }, async () => {
    telemetry.event("analysis_started", { eventType: "QOE_FORECAST" });
    const result = await instrumented.generate(request);
    telemetry.event("analysis_completed", { eventType: "QOE_FORECAST" });
    return result;
  });
  assert.equal(returned, response);
  await telemetry.forceFlush();

  const finished = spans.getFinishedSpans();
  const analysisSpan = finished.find((span) => span.name === "analysis.message");
  const llmSpan = finished.find((span) => span.name === "llm.generate");
  assert.ok(analysisSpan);
  assert.ok(llmSpan);
  assert.equal(llmSpan.spanContext().traceId, analysisSpan.spanContext().traceId);
  assert.equal(llmSpan.parentSpanContext?.spanId, analysisSpan.spanContext().spanId);
  assert.equal(llmSpan.attributes["gen_ai.system"], "ollama");
  assert.equal(llmSpan.attributes["gen_ai.request.model"], "qwen2.5:7b");
  assert.deepEqual(llmSpan.attributes["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(llmSpan.attributes["llm.status"], "success");

  const snapshot = await metrics.snapshot();
  const requests = findMetric(snapshot, "llm_requests_total");
  assert.deepEqual(requests?.dataPoints[0]?.attributes, {
    provider: "ollama",
    model_id: "qwen2.5:7b",
    status: "success",
    stop_reason: "stop",
  });
  const tokens = findMetric(snapshot, "llm_tokens_total");
  assert.deepEqual(
    tokens?.dataPoints.map((point) => [point.attributes.token_type, point.value]).sort(),
    [["input", 120], ["output", 45]],
  );
  assert.doesNotMatch(JSON.stringify(lines), /SYSTEM_SENTINEL|USER_SENTINEL|RESPONSE_SENTINEL/);
  await telemetry.shutdown();
});

test("observes length and other as failures without mutating responses", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricReader();
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    metricReader: metrics,
    write: () => {},
  });
  const responses: LlmResponse[] = [
    { text: "{}", provider: "ollama", modelId: "m", stopReason: "length" },
    { text: "{}", provider: "ollama", modelId: "m", stopReason: "other" },
  ];
  let index = 0;
  const provider = instrumentLlmProvider(
    { generate: async () => responses[index++]! },
    telemetry,
    { provider: "ollama", modelId: "m" },
  );

  assert.equal(await provider.generate(request), responses[0]);
  assert.equal(await provider.generate(request), responses[1]);
  await telemetry.forceFlush();

  const llmSpans = spans.getFinishedSpans().filter((span) => span.name === "llm.generate");
  assert.deepEqual(llmSpans.map((span) => span.attributes["llm.status"]), ["failure", "failure"]);
  const snapshot = await metrics.snapshot();
  const requests = findMetric(snapshot, "llm_requests_total");
  assert.deepEqual(
    requests?.dataPoints.map((point) => point.attributes.stop_reason).sort(),
    ["length", "other"],
  );
  assert.equal(findMetric(snapshot, "llm_tokens_total"), undefined);
  await telemetry.shutdown();
});

test("propagates the same error and exports only its stable code", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricReader();
  const lines: string[] = [];
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    metricReader: metrics,
    write: (line) => lines.push(line),
  });
  const failure = Object.assign(new Error("ERROR_MESSAGE_SENTINEL"), {
    code: "OLLAMA_NETWORK",
  });
  const provider = instrumentLlmProvider(
    { generate: async () => { throw failure; } },
    telemetry,
    identity,
  );

  await assert.rejects(() => provider.generate(request), (error: unknown) => error === failure);
  await telemetry.forceFlush();

  const llmSpan = spans.getFinishedSpans().find((span) => span.name === "llm.generate");
  assert.equal(llmSpan?.attributes["error.type"], "OLLAMA_NETWORK");
  assert.equal(llmSpan?.attributes["llm.status"], "failure");
  assert.equal(llmSpan?.events.length, 0);
  assert.doesNotMatch(
    JSON.stringify({ attributes: llmSpan?.attributes, lines }),
    /ERROR_MESSAGE_SENTINEL|SYSTEM_SENTINEL|USER_SENTINEL/,
  );

  const snapshot = await metrics.snapshot();
  const stops = findMetric(snapshot, "llm_response_stop_total");
  assert.equal(stops?.dataPoints[0]?.attributes.stop_reason, "error");
  await telemetry.shutdown();
});

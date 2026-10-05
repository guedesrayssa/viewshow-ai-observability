import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DataPointType,
  MetricReader,
  type CollectionResult,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  type AgenticTelemetry,
  createAgenticTelemetry,
  telemetryConfigFromEnv,
} from "../src/observability/agentic-telemetry.js";

class InMemoryMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  snapshot(): Promise<CollectionResult> {
    return this.collect();
  }
}

function metric(result: CollectionResult, name: string): MetricData {
  const found = result.resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
  assert.ok(found, `metric ${name} was not collected`);
  return found;
}

test("records successful analysis count, duration and consumer span", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricReader();
  let now = 1_000;
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    metricReader: metrics,
    now: () => now,
    write: () => {},
  });

  const result = await telemetry.runMessage(
    { id: "message-success", receives: 1 },
    async () => {
      telemetry.event("analysis_started", { eventType: "ANOMALY_DETECTION" });
      now = 1_250;
      telemetry.event("analysis_completed", {
        eventType: "ANOMALY_DETECTION",
        scopes: 1,
      });
      return "ok";
    },
  );
  assert.equal(result, "ok");
  assert.equal(await telemetry.forceFlush(), true);

  const [span] = spans.getFinishedSpans();
  assert.equal(span?.name, "analysis.message");
  assert.equal(span?.attributes["messaging.system"], "sqs");
  assert.equal(span?.attributes["messaging.message.id"], "message-success");
  assert.equal(span?.attributes["viewshow.retry_count"], 0);
  assert.equal(span?.attributes["viewshow.event_type"], "ANOMALY_DETECTION");
  assert.equal(span?.attributes["viewshow.analysis_status"], "success");

  const snapshot = await metrics.snapshot();
  const count = metric(snapshot, "analysis_messages_total");
  assert.equal(count.dataPointType, DataPointType.SUM);
  assert.deepEqual(count.dataPoints[0]?.attributes, {
    event_type: "ANOMALY_DETECTION",
    status: "success",
  });
  assert.equal(count.dataPoints[0]?.value, 1);

  const duration = metric(snapshot, "analysis_run_duration_seconds");
  assert.equal(duration.dataPointType, DataPointType.HISTOGRAM);
  assert.equal(duration.dataPoints[0]?.value.count, 1);
  assert.equal(duration.dataPoints[0]?.value.sum, 0.25);
  await telemetry.shutdown();
});

test("maps terminal failures to failure and deferrals to retry", async () => {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricReader();
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    metricReader: metrics,
    write: () => {},
  });

  await telemetry.runMessage({ id: "terminal", receives: 5 }, async () => {
    telemetry.event("analysis_started", { eventType: "QOE_FORECAST" });
    telemetry.event("analysis_failed", {
      eventType: "QOE_FORECAST",
      code: "DEPENDENCY_FAILURE",
      terminal: true,
    });
  });
  await telemetry.runMessage({ id: "retry", receives: 2 }, async () => {
    telemetry.event("analysis_started", { eventType: "REANALYSIS_REQUESTED" });
    telemetry.event("analysis_failed", {
      eventType: "REANALYSIS_REQUESTED",
      code: "DEPENDENCY_FAILURE",
      terminal: false,
    });
  });
  await telemetry.runMessage({ id: "busy", receives: 1 }, async () => {
    telemetry.event("analysis_started", { eventType: "ANOMALY_DETECTION" });
    telemetry.event("analysis_deferred", {
      eventType: "ANOMALY_DETECTION",
      reason: "lease_busy",
    });
  });
  await telemetry.forceFlush();

  const statuses = spans.getFinishedSpans().map(
    (span) => span.attributes["viewshow.analysis_status"],
  );
  assert.deepEqual(statuses, ["failure", "retry", "retry"]);

  const snapshot = await metrics.snapshot();
  const count = metric(snapshot, "analysis_messages_total");
  assert.deepEqual(
    count.dataPoints.map((point) => point.attributes.status).sort(),
    ["failure", "retry", "retry"],
  );
  await telemetry.shutdown();
});

test("isolates concurrent message context when operations finish out of order", async () => {
  const spans = new InMemorySpanExporter();
  const lines: string[] = [];
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: spans,
    write: (line) => lines.push(line),
  });
  let releaseA!: () => void;
  const waitForB = new Promise<void>((resolve) => { releaseA = resolve; });

  await Promise.all([
    telemetry.runMessage({ id: "message-a", receives: 1 }, async () => {
      telemetry.event("analysis_started", { eventType: "ANOMALY_DETECTION" });
      await waitForB;
      telemetry.event("analysis_completed", { eventType: "ANOMALY_DETECTION" });
    }),
    telemetry.runMessage({ id: "message-b", receives: 2 }, async () => {
      telemetry.event("analysis_started", { eventType: "QOE_FORECAST" });
      releaseA();
      telemetry.event("analysis_failed", {
        eventType: "QOE_FORECAST",
        code: "DEPENDENCY_FAILURE",
        terminal: false,
      });
    }),
  ]);
  await telemetry.forceFlush();

  const byMessage = new Map(spans.getFinishedSpans().map((span) => [
    span.attributes["messaging.message.id"],
    span.attributes,
  ]));
  assert.equal(byMessage.get("message-a")?.["viewshow.event_type"], "ANOMALY_DETECTION");
  assert.equal(byMessage.get("message-a")?.["viewshow.analysis_status"], "success");
  assert.equal(byMessage.get("message-b")?.["viewshow.event_type"], "QOE_FORECAST");
  assert.equal(byMessage.get("message-b")?.["viewshow.analysis_status"], "retry");

  for (const line of lines.map((value) => JSON.parse(value) as Record<string, unknown>)) {
    assert.equal(typeof line.trace_id, "string");
    assert.equal(typeof line.span_id, "string");
  }
  await telemetry.shutdown();
});

test("writer and exporter failures do not change the business result", async () => {
  const failingExporter: SpanExporter = {
    export(_spans, callback) {
      callback({ code: 1, error: new Error("collector unavailable") });
    },
    async shutdown() {},
  };
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: failingExporter,
    write: () => { throw new Error("stdout unavailable"); },
  });

  const result = await telemetry.runMessage({ id: "safe", receives: 1 }, async () => {
    telemetry.event("analysis_started", { eventType: "QOE_FORECAST" });
    telemetry.event("analysis_completed", { eventType: "QOE_FORECAST" });
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(await telemetry.forceFlush(100), false);
  await telemetry.shutdown();
});

test("concrete telemetry shutdown reports provider failures with a stable sanitized code", async () => {
  const exporter: SpanExporter = {
    export(_spans, callback) { callback({ code: 0 }); },
    async shutdown() { throw new Error("SHUTDOWN_PROVIDER_SECRET_SENTINEL"); },
  };
  const telemetry = createAgenticTelemetry(telemetryConfigFromEnv({}), {
    spanExporter: exporter,
    write: () => {},
  });

  await assert.rejects(telemetry.shutdown(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, "TELEMETRY_SHUTDOWN_FAILED");
    assert.doesNotMatch(error.message, /SECRET_SENTINEL/);
    return true;
  });
});

test("runMessage delivery contract excludes the message body", () => {
  type RunDelivery = Parameters<AgenticTelemetry["runMessage"]>[0];
  const acceptsRunDelivery = (_delivery: RunDelivery): void => {};
  if (false) {
    // @ts-expect-error The message body must never cross the telemetry boundary.
    acceptsRunDelivery({ id: "message", receives: 1, body: "sensitive" });
  }
  assert.ok(true);
});

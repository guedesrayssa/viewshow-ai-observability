import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisWorker } from "../src/worker/orchestrator.js";
import type { Delivery } from "../src/worker/types.js";
import type { AgenticTelemetry } from "../src/observability/agentic-telemetry.js";
import {
  drainAndShutdown,
  processObservedDelivery,
} from "../src/bootstrap/worker-runtime.js";

const delivery: Delivery = { id: "message-1", receipt: "receipt", body: "{}", receives: 1 };

function fakeTelemetry(options: {
  runMessage?: AgenticTelemetry["runMessage"];
  forceFlush?: AgenticTelemetry["forceFlush"];
  shutdown?: AgenticTelemetry["shutdown"];
} = {}) {
  const events: Array<{ name: string; fields: Record<string, string | number | boolean | null> }> = [];
  const telemetry: AgenticTelemetry = {
    event: (name, fields) => events.push({ name, fields }),
    async runMessage<T>(
      runDelivery: Pick<Delivery, "id" | "receives">,
      operation: () => Promise<T>,
    ): Promise<T> {
      if (options.runMessage) return options.runMessage(runDelivery, operation);
      return operation();
    },
    traceLlm: async (_identity, operation) => operation(),
    forceFlush: options.forceFlush ?? (async () => true),
    shutdown: options.shutdown ?? (async () => {}),
  };
  return { telemetry, events };
}

test("processObservedDelivery composes one message span around one worker call", async () => {
  let runCalls = 0;
  let workerCalls = 0;
  const { telemetry } = fakeTelemetry({
    runMessage: async (runDelivery, operation) => {
      runCalls++;
      assert.deepEqual(runDelivery, { id: "message-1", receives: 1 });
      return operation();
    },
  });
  const worker = {
    process: async (received: Delivery) => {
      workerCalls++;
      assert.equal(received, delivery);
    },
  } as Pick<AnalysisWorker, "process">;

  await processObservedDelivery(worker, telemetry, delivery);
  assert.equal(runCalls, 1);
  assert.equal(workerCalls, 1);
});

test("processObservedDelivery preserves an unexpected worker error", async () => {
  const failure = new Error("worker failed");
  const { telemetry } = fakeTelemetry();
  const worker = { process: async () => { throw failure; } } as Pick<AnalysisWorker, "process">;
  await assert.rejects(
    () => processObservedDelivery(worker, telemetry, delivery),
    (error: unknown) => error === failure,
  );
});

test("drain waits for active work, flushes, and then shuts down", async () => {
  const order: string[] = [];
  let release!: () => void;
  const active = new Promise<void>((resolve) => { release = resolve; });
  const { telemetry } = fakeTelemetry({
    forceFlush: async () => { order.push("flush"); return true; },
    shutdown: async () => { order.push("shutdown"); },
  });
  const draining = drainAndShutdown(new Set([active]), telemetry, 100);
  await Promise.resolve();
  assert.equal(order.length, 0);
  order.push("active");
  release();

  await draining;
  assert.deepEqual(order, ["active", "flush", "shutdown"]);
});

test("flush and shutdown failures are sanitized and never reject shutdown", async () => {
  const { telemetry, events } = fakeTelemetry({
    forceFlush: async () => { throw new Error("FLUSH_SECRET_SENTINEL"); },
    shutdown: async () => { throw new TypeError("SHUTDOWN_SECRET_SENTINEL"); },
  });

  await drainAndShutdown(new Set(), telemetry, 100);

  assert.deepEqual(events.map((entry) => entry.name), [
    "telemetry_flush_failed",
    "telemetry_shutdown_failed",
  ]);
  assert.equal(events[0]?.fields.errorType, "Error");
  assert.equal(events[1]?.fields.errorType, "TypeError");
  assert.doesNotMatch(JSON.stringify(events), /SECRET_SENTINEL/);
});

test("a false flush result is logged and shutdown still runs", async () => {
  let shutdownCalls = 0;
  const { telemetry, events } = fakeTelemetry({
    forceFlush: async () => false,
    shutdown: async () => { shutdownCalls++; },
  });
  await drainAndShutdown(new Set(), telemetry, 100);
  assert.equal(shutdownCalls, 1);
  assert.deepEqual(events, [{
    name: "telemetry_flush_failed",
    fields: { errorType: "FlushFailed" },
  }]);
});

test("timeout still shuts down and resolves promptly", async () => {
  let shutdownCalls = 0;
  const never = new Promise<void>(() => {});
  const { telemetry } = fakeTelemetry({
    shutdown: async () => { shutdownCalls++; },
  });
  const started = performance.now();
  await drainAndShutdown(new Set([never]), telemetry, 10);
  assert.equal(shutdownCalls, 1);
  assert.ok(performance.now() - started < 200);
});

test("drain, flush and shutdown share one bounded deadline", async () => {
  const never = new Promise<void>(() => {});
  let flushCalls = 0;
  let shutdownCalls = 0;
  const { telemetry } = fakeTelemetry({
    forceFlush: async () => { flushCalls++; return never.then(() => true); },
    shutdown: async () => { shutdownCalls++; return never; },
  });
  const started = performance.now();
  await drainAndShutdown(new Set([Promise.resolve()]), telemetry, 20);
  const elapsed = performance.now() - started;
  assert.equal(flushCalls, 1);
  assert.equal(shutdownCalls, 1);
  assert.ok(elapsed < 100, `elapsed ${elapsed}ms`);
});

test("shutdown deadline uses the injected monotonic clock", async () => {
  const never = new Promise<void>(() => {});
  const { telemetry, events } = fakeTelemetry({
    forceFlush: async () => never.then(() => true),
    shutdown: async () => never,
  });
  const times = [100, 100, 105, 111, 111];
  await drainAndShutdown(
    new Set([Promise.resolve()]),
    telemetry,
    10,
    () => times.shift() ?? 111,
  );
  assert.match(JSON.stringify(events), /FlushTimeout|ShutdownTimeout/);
});

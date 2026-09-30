import type { AgenticTelemetry } from "../observability/agentic-telemetry.js";
import type { AnalysisWorker } from "../worker/orchestrator.js";
import type { Delivery } from "../worker/types.js";

export function safeErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  const name = typeof error === "object" && error !== null
    ? error.constructor?.name
    : undefined;
  const sanitized = (name || "Error").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return sanitized || "Error";
}

export async function processObservedDelivery(
  worker: Pick<AnalysisWorker, "process">,
  telemetry: AgenticTelemetry,
  delivery: Delivery,
): Promise<void> {
  await telemetry.runMessage(
    { id: delivery.id, receives: delivery.receives },
    () => worker.process(delivery),
  );
}

export async function drainAndShutdown(
  active: ReadonlySet<Promise<void>>,
  telemetry: AgenticTelemetry,
  timeoutMs: number,
  monotonic: () => number = () => performance.now(),
): Promise<void> {
  const deadline = monotonic() + Math.max(timeoutMs, 0);
  await settleBefore(Promise.allSettled([...active]), deadline, monotonic);

  try {
    const remaining = Math.max(deadline - monotonic(), 0);
    const flush = await settleBefore(telemetry.forceFlush(remaining), deadline, monotonic);
    if (!flush.settled || flush.value !== true) {
      telemetry.event("telemetry_flush_failed", {
        errorType: flush.settled ? "FlushFailed" : "FlushTimeout",
      });
    }
  } catch (error) {
    telemetry.event("telemetry_flush_failed", { errorType: safeErrorType(error) });
  }

  try {
    const shutdown = await settleBefore(telemetry.shutdown(), deadline, monotonic);
    if (!shutdown.settled) {
      telemetry.event("telemetry_shutdown_failed", { errorType: "ShutdownTimeout" });
    }
  } catch (error) {
    telemetry.event("telemetry_shutdown_failed", { errorType: safeErrorType(error) });
  }
}

async function settleBefore<T>(
  operation: Promise<T>,
  deadline: number,
  monotonic: () => number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  const remaining = Math.max(deadline - monotonic(), 0);
  if (remaining === 0) {
    void operation.catch(() => undefined);
    return { settled: false };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ settled: false }), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

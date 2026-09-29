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
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, Math.max(timeoutMs, 0));
  });
  try {
    await Promise.race([Promise.allSettled([...active]).then(() => undefined), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  try {
    const flushed = await telemetry.forceFlush(Math.max(timeoutMs, 0));
    if (!flushed) telemetry.event("telemetry_flush_failed", { errorType: "FlushFailed" });
  } catch (error) {
    telemetry.event("telemetry_flush_failed", { errorType: safeErrorType(error) });
  }

  try {
    await telemetry.shutdown();
  } catch (error) {
    telemetry.event("telemetry_shutdown_failed", { errorType: safeErrorType(error) });
  }
}

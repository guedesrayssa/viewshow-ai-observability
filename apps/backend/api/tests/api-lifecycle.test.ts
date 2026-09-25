import { describe, expect, it, vi } from "vitest";
import { stopApiServices } from "../src/api-lifecycle.js";

describe("API lifecycle", () => {
  it("stops reconciliation before waiting for a pending HTTP drain", async () => {
    const order: string[] = [];
    let stopped = false;
    let effects = 0;
    let finishClose: ((error?: Error) => void) | undefined;
    const reconciler = {
      stop: vi.fn(async () => {
        order.push("reconciler");
        stopped = true;
      }),
    };
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        order.push("server-close-started");
        finishClose = callback;
      }),
    };
    const stopTelemetry = vi.fn(async () => {
      order.push("telemetry");
    });
    const scheduledTick = () => {
      if (!stopped) effects += 1;
    };

    const stopping = stopApiServices({ server, reconciler, stopTelemetry });
    await Promise.resolve();
    scheduledTick();
    expect(effects).toBe(0);
    expect(order).toEqual(["server-close-started", "reconciler"]);
    finishClose?.();
    await expect(stopping).resolves.toBeNull();
    expect(order).toEqual(["server-close-started", "reconciler", "telemetry"]);
  });

  it("still stops reconciliation and telemetry when server close reports an error", async () => {
    const failure = new Error("close failed");
    const reconciler = { stop: vi.fn(async () => {}) };
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback(failure)),
    };
    const stopTelemetry = vi.fn(async () => {});
    await expect(
      stopApiServices({ server, reconciler, stopTelemetry }),
    ).resolves.toBe(failure);
    expect(reconciler.stop).toHaveBeenCalledTimes(1);
    expect(stopTelemetry).toHaveBeenCalledTimes(1);
  });
});

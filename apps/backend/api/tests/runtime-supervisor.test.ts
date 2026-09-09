import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  processSpecs,
  startSupervisor,
} from "../runtime-compat/src/supervisor.js";

function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = vi.fn(() => true);
  return emitter;
}

describe("ECS compatibility supervisor", () => {
  it("defines four distinct processes and exposes only the gateway", () => {
    const specs = processSpecs("/app", {
      NODE_ENV: "test",
      AUTH_COOKIE_SECRET: "s".repeat(32),
    });
    expect(specs.map((spec) => spec.name)).toEqual([
      "incidents-service",
      "dashboard-query-service",
      "identity-service",
      "api-gateway",
    ]);
    expect(
      specs.find((spec) => spec.name === "api-gateway")?.environment,
    ).toMatchObject({ HOST: "0.0.0.0", PORT: "3000" });
    for (const spec of specs.filter((item) => item.name !== "api-gateway")) {
      expect(Object.values(spec.environment)).toContain("127.0.0.1");
    }
  });

  it("forwards shutdown and marks an unexpected essential death fatal", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const onFatal = vi.fn();
    const supervisor = startSupervisor({
      root: "/app",
      environment: { NODE_ENV: "test", AUTH_COOKIE_SECRET: "s".repeat(32) },
      spawnProcess: () => {
        const child = fakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
      onFatal,
    });
    children[0]?.emit("exit", 2, null);
    expect(onFatal).toHaveBeenCalledWith(2);
    expect(
      children.slice(1).every((child) => child.kill.mock.calls.length === 1),
    ).toBe(true);
    supervisor.stop("SIGTERM");
  });

  it("fails closed when production has no cookie secret", () => {
    expect(() =>
      startSupervisor({
        root: "/app",
        environment: { NODE_ENV: "production" },
        spawnProcess: () => fakeChild() as unknown as ChildProcess,
      }),
    ).toThrow(/AUTH_COOKIE_SECRET/);
  });
});

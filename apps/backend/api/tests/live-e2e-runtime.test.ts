import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

type EndpointRuntime = {
  requireDynamoDbEndpoint(environment: NodeJS.ProcessEnv): string;
  liveApiChildEnvironment?: (input: {
    endpoint: string;
    port: number;
    tableName: string;
    authSecret: string;
    cursorSecret: string;
  }) => NodeJS.ProcessEnv;
  terminateChild?: (
    child: EventEmitter & {
      exitCode: number | null;
      kill(signal: NodeJS.Signals): boolean;
    },
    timeoutMilliseconds?: number,
  ) => Promise<void>;
  cleanupLiveApiResources?: (steps: {
    stopApi(): Promise<void>;
    deleteTable(): Promise<void>;
    destroyClient(): void;
  }) => Promise<void>;
};

async function loadRuntime(): Promise<EndpointRuntime | null> {
  try {
    return (await import("../scripts/live-e2e-runtime.mjs")) as EndpointRuntime;
  } catch {
    return null;
  }
}

describe("live E2E runtime safety", () => {
  it("rejects live execution before any network access when the endpoint is absent", async () => {
    const runtime = await loadRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    expect(() => runtime.requireDynamoDbEndpoint({})).toThrow(
      "DYNAMODB_ENDPOINT is required for live E2E",
    );
  });

  it("accepts only loopback DynamoDB endpoints and the exact CI service endpoint", async () => {
    const runtime = await loadRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    for (const endpoint of [
      "http://127.0.0.1:18000",
      "http://localhost:8000",
      "http://[::1]:8000",
      "http://dynamodb:8000",
    ])
      expect(
        runtime.requireDynamoDbEndpoint({ DYNAMODB_ENDPOINT: endpoint }),
      ).toBe(endpoint);

    for (const endpoint of [
      "https://127.0.0.1:8000",
      "http://user:password@127.0.0.1:8000",
      "http://127.0.0.1:8000?",
      "http://127.0.0.1:8000?region=us-east-1",
      "http://127.0.0.1:8000#",
      "http://127.0.0.1:8000#tables",
      "http://example.test:8000",
      "http://dynamodb.us-east-1.amazonaws.com:8000",
      "https://dynamodb.us-east-1.amazonaws.com",
      "http://dynamodb:8001",
      "http://dynamodb:8000/tables",
      "http://127.0.0.1:8000/.",
      "http://127.0.0.1:8000/..",
      "http://127.0.0.1:8000/%2e%2e",
      "http://127.0.0.1:8000/tables/..",
    ])
      expect(
        () => runtime.requireDynamoDbEndpoint({ DYNAMODB_ENDPOINT: endpoint }),
        endpoint,
      ).toThrow("DYNAMODB_ENDPOINT must be a local DynamoDB URL");
  });

  it("exits its CLI guard before the E2E when the endpoint is absent", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/live-e2e-runtime.mjs"],
      { cwd: process.cwd(), env: {}, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DYNAMODB_ENDPOINT is required for live E2E",
    );
  });

  it("builds a minimal child environment without inherited AWS identity or config", async () => {
    const runtime = await loadRuntime();
    expect(typeof runtime?.liveApiChildEnvironment).toBe("function");
    if (!runtime?.liveApiChildEnvironment) return;

    const environment = runtime.liveApiChildEnvironment({
      endpoint: "http://127.0.0.1:18000",
      port: 32123,
      tableName: "monitoracao-operacional-e2e",
      authSecret: "a".repeat(32),
      cursorSecret: "c".repeat(32),
    });

    expect(environment).toEqual({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "32123",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "local",
      AWS_SECRET_ACCESS_KEY: "local",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      DYNAMODB_ENDPOINT: "http://127.0.0.1:18000",
      OPERATIONAL_TABLE_NAME: "monitoracao-operacional-e2e",
      MONITORING_SOURCES: "argus",
      AUTH_COOKIE_SECRET: "a".repeat(32),
      CURSOR_SECRET: "c".repeat(32),
      METRICS_ENABLED: "true",
    });
    expect(environment).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(environment).not.toHaveProperty("AWS_PROFILE");
    expect(environment).not.toHaveProperty("AWS_WEB_IDENTITY_TOKEN_FILE");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
  });

  it("bounds graceful shutdown and escalates a stuck child to SIGKILL", async () => {
    const runtime = await loadRuntime();
    expect(typeof runtime?.terminateChild).toBe("function");
    if (!runtime?.terminateChild) return;

    const signals: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          child.exitCode = 137;
          queueMicrotask(() => child.emit("exit", 137, "SIGKILL"));
        }
        return true;
      },
    });

    await runtime.terminateChild(child, 5);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("attempts table deletion and client destruction even when earlier cleanup fails", async () => {
    const runtime = await loadRuntime();
    expect(typeof runtime?.cleanupLiveApiResources).toBe("function");
    if (!runtime?.cleanupLiveApiResources) return;

    const calls: string[] = [];
    await expect(
      runtime.cleanupLiveApiResources({
        async stopApi() {
          calls.push("stop");
          throw new Error("stop failed");
        },
        async deleteTable() {
          calls.push("delete");
          throw new Error("delete failed");
        },
        destroyClient() {
          calls.push("destroy");
        },
      }),
    ).rejects.toThrow();

    expect(calls).toEqual(["stop", "delete", "destroy"]);
  });
});

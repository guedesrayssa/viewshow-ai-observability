import { afterEach, describe, expect, it, vi } from "vitest";
import { trace, TraceFlags } from "@opentelemetry/api";
import {
  LokiTransport,
  addLogContext,
  createLogThrottle,
  createLogger,
  getLogTransportStats,
  isSensitiveKey,
  resetLogTransport,
  runWithLogContext,
  sanitizeFields,
  scrubText,
  serializeError,
} from "@view-show/contracts";

function captureStdout(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetLogTransport();
});

describe("log redaction", () => {
  it("scrubs credentials in the top-level log message as well as fields", () => {
    const rows = captureStdout(() =>
      createLogger("view-show-api").warn(
        "upstream refused Bearer abcdefghijklmnop at /callback?code=SECRETCODE&state=PRIVATESTATE",
        { event: "upstream.failure", password: "PRIVATEPASSWORD" },
      ),
    );
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    for (const secret of [
      "abcdefghijklmnop",
      "SECRETCODE",
      "PRIVATESTATE",
      "PRIVATEPASSWORD",
    ])
      expect(serialized).not.toContain(secret);
    expect(rows[0].message).toContain("[REDACTED]");
  });

  it("redacts credential-like keys at any depth and spelling", () => {
    const safe = sanitizeFields({
      password: "p1",
      accessToken: "t1",
      id_token: "t2",
      "set-cookie": "c1",
      Authorization: "Bearer abc",
      "x-internal-token": "i1",
      IMPORT_CURSOR_SECRET: "s1",
      apiKey: "k1",
      sessionId: "sess",
      nested: { deep: [{ clientSecret: "cs" }] },
      status: 503,
      error_code: "DATA_UNAVAILABLE",
      request_id: "req_1",
    });
    const serialized = JSON.stringify(safe);
    for (const leaked of [
      "p1",
      "t1",
      "t2",
      "c1",
      "i1",
      "s1",
      "k1",
      "sess",
      "cs",
    ])
      expect(serialized).not.toContain(`"${leaked}"`);
    expect(safe).toMatchObject({
      status: 503,
      error_code: "DATA_UNAVAILABLE",
      request_id: "req_1",
    });
    expect(isSensitiveKey("error_code")).toBe(false);
    expect(isSensitiveKey("duration_ms")).toBe(false);
  });

  it("scrubs secrets that appear inside free text", () => {
    const text = scrubText(
      [
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl",
        "header Bearer abcdefghijklmnop",
        "url https://bucket.s3.amazonaws.com/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP%2F2026&part=3",
        "callback /auth/callback?code=SECRETCODE&state=xyz",
        "password=hunter2 and token: abc123",
        "key AKIAABCDEFGHIJKLMNOP",
        "owner jane.doe@globoplay.com",
      ].join(" | "),
    );
    for (const leaked of [
      "eyJhbGci",
      "abcdefghijklmnop",
      "deadbeef",
      "SECRETCODE",
      "hunter2",
      "abc123",
      "AKIAABCDEFGHIJKLMNOP",
      "jane.doe",
    ])
      expect(text).not.toContain(leaked);
    expect(text).toContain("part=3");
    expect(text).toContain("j***@globoplay.com");
  });

  it("survives cycles, bigints and oversized values without throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const safe = sanitizeFields({
      cyclic,
      big: 12n,
      huge: "x".repeat(10_000),
      many: Array.from({ length: 500 }, (_, index) => index),
    });
    expect(JSON.stringify(safe).length).toBeLessThan(6_000);
    expect(safe.big).toBe("12");
  });
});

describe("error serialization", () => {
  it("keeps business and AWS identifiers and puts the stack in its own field", () => {
    const error = Object.assign(
      new Error("Throughput exceeded for token=abc123", {
        cause: new Error("socket hang up"),
      }),
      {
        name: "ProvisionedThroughputExceededException",
        $metadata: { requestId: "aws-req-1", httpStatusCode: 400 },
      },
    );
    const withStack = serializeError(error, { includeStack: true });
    expect(withStack).toMatchObject({
      type: "ProvisionedThroughputExceededException",
      status: 400,
      aws_request_id: "aws-req-1",
      cause: "Error: socket hang up",
    });
    expect(withStack.message).toBe("Throughput exceeded for token=[REDACTED]");
    expect(withStack.stack).toContain("Throughput exceeded");
    expect(serializeError(error).stack).toBeUndefined();
  });

  it("handles values that are not errors", () => {
    expect(serializeError("plain string")).toMatchObject({
      type: "NonError",
      message: "plain string",
    });
  });
});

describe("structured logger", () => {
  it("adds environment, version, request context and trace ids", () => {
    vi.stubEnv("OTEL_DEPLOYMENT_ENVIRONMENT", "aws");
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "service.version=abc123,cloud.region=us-east-1",
    );
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.SAMPLED,
      }),
    } as never);
    const [line] = captureStdout(() =>
      runWithLogContext({ request_id: "req_ctx" }, () => {
        addLogContext({ user_id: "u-1" });
        createLogger("view-show-api").info("hello", {
          event: "demo.event",
          password: "never",
        });
      }),
    );
    expect(line).toMatchObject({
      level: "info",
      service_name: "view-show-api",
      environment: "aws",
      service_version: "abc123",
      request_id: "req_ctx",
      user_id: "u-1",
      event: "demo.event",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      password: "[REDACTED]",
      message: "hello",
    });
  });

  it("does not let callers forge fields owned by the logger", () => {
    const [line] = captureStdout(() =>
      createLogger("view-show-api").warn("real", {
        level: "info",
        service_name: "forged",
        environment: "forged",
        service_version: "forged",
        timestamp: "forged",
        message: "forged",
      }),
    );
    expect(line).toMatchObject({
      level: "warn",
      service_name: "view-show-api",
      message: "real",
    });
    expect(line?.environment).not.toBe("forged");
    expect(line?.timestamp).not.toBe("forged");
  });

  it("honors LOG_LEVEL on every call", () => {
    const logger = createLogger("view-show-api");
    vi.stubEnv("LOG_LEVEL", "error");
    expect(
      captureStdout(() => {
        logger.info("quiet");
        logger.warn("quiet");
        logger.error("loud");
      }).map((line) => line.message),
    ).toEqual(["loud"]);
    vi.stubEnv("LOG_LEVEL", "silent");
    expect(captureStdout(() => logger.error("nothing"))).toHaveLength(0);
  });

  it("never throws when a field cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const [line] = captureStdout(() =>
      createLogger("view-show-api").info("ok", { circular }),
    );
    expect(line?.message).toBe("ok");
  });
});

describe("log throttle", () => {
  it("emits the first event and reports how many repeats were suppressed", () => {
    let clock = 0;
    const throttle = createLogThrottle(1_000, () => clock);
    expect(throttle("absent")).toEqual({ emit: true, suppressed: 0 });
    expect(throttle("absent").emit).toBe(false);
    expect(throttle("absent").emit).toBe(false);
    expect(throttle("io").emit).toBe(true);
    clock = 1_000;
    expect(throttle("absent")).toEqual({ emit: true, suppressed: 2 });
  });
});

describe("Loki transport", () => {
  const labels = (level: string) => ({
    service_name: "view-show-api",
    level,
    environment: "test",
  });

  it("sends one request per batch, grouped by stream, with ordered timestamps", async () => {
    const calls: { url: string; body: { streams: unknown[] } }[] = [];
    const transport = new LokiTransport({
      url: "http://loki.test/loki/api/v1/push",
      flushIntervalMs: 60_000,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    transport.enqueue(labels("info"), "a", 1_700_000_000_000);
    transport.enqueue(labels("info"), "b", 1_700_000_000_000);
    transport.enqueue(labels("error"), "c", 1_700_000_000_001);
    await transport.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://loki.test/loki/api/v1/push");
    const streams = calls[0]?.body.streams as {
      stream: { level: string };
      values: [string, string][];
    }[];
    expect(streams.map((stream) => stream.stream.level).sort()).toEqual([
      "error",
      "info",
    ]);
    const info = streams.find((stream) => stream.stream.level === "info");
    expect(info?.values.map(([, line]) => line)).toEqual(["a", "b"]);
    expect(info?.values[0]?.[0]).not.toBe(info?.values[1]?.[0]);
    expect(transport.stats()).toMatchObject({
      pushedLines: 3,
      failures: 0,
      droppedLines: 0,
      bufferedLines: 0,
    });
  });

  it("drops the oldest lines when the buffer is full and counts the loss", async () => {
    const sent: string[] = [];
    const transport = new LokiTransport({
      url: "http://loki.test/push",
      flushIntervalMs: 60_000,
      maxBatchLines: 100,
      maxBufferLines: 3,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        for (const stream of JSON.parse(init.body).streams)
          for (const [, line] of stream.values) sent.push(line);
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    for (const line of ["1", "2", "3", "4", "5"])
      transport.enqueue(labels("info"), line, 1);
    await transport.flush();
    expect(sent).toEqual(["3", "4", "5"]);
    expect(transport.stats().droppedLines).toBe(2);
  });

  it("counts failures without throwing when Loki is down", async () => {
    const transport = new LokiTransport({
      url: "http://loki.test/push",
      flushIntervalMs: 60_000,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    transport.enqueue(labels("info"), "x", 1);
    await expect(transport.flush()).resolves.toBeUndefined();
    expect(transport.stats()).toMatchObject({
      failures: 1,
      droppedLines: 1,
      pushedLines: 0,
    });
  });

  it("treats a non-2xx answer as a failed push", async () => {
    const transport = new LokiTransport({
      url: "http://loki.test/push",
      flushIntervalMs: 60_000,
      fetchImpl: (async () =>
        new Response("rate limited", {
          status: 429,
        })) as unknown as typeof fetch,
    });
    transport.enqueue(labels("info"), "x", 1);
    await transport.flush();
    expect(transport.stats().failures).toBe(1);
  });

  it("is fed by the logger only when LOKI_PUSH_URL is set", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("LOKI_PUSH_URL", "");
    resetLogTransport();
    captureStdout(() => createLogger("view-show-api").info("no transport"));
    expect(getLogTransportStats().enabled).toBe(false);

    vi.stubEnv("LOKI_PUSH_URL", "http://loki.test/loki/api/v1/push");
    vi.stubEnv("LOKI_FLUSH_INTERVAL_MS", "60000");
    resetLogTransport();
    captureStdout(() => createLogger("view-show-api").info("with transport"));
    expect(getLogTransportStats()).toMatchObject({
      enabled: true,
      bufferedLines: 1,
    });
  });
});

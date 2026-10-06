import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trace, TraceFlags } from "@opentelemetry/api";
import { ServiceError, resetLogTransport } from "@view-show/contracts";
import { createApp } from "../src/app.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { importFixture } from "./support/import-fixture.ts";

const secret = "x".repeat(32);
const servers: Server[] = [];

type Line = Record<string, unknown>;

function captureStdout(): { lines: () => Line[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Line),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function appWith(overview: () => Promise<never>) {
  return createApp({
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      frontendOrigins: ["http://frontend.test"],
      metricsEnabled: true,
      rateLimitPerMinute: 10_000,
      authLoginRateLimitPerMinute: 10_000,
    },
    incidents: {} as never,
    dashboard: { overview } as never,
    imports: importFixture().useCases,
    auth: createAuthModule({ AUTH_COOKIE_SECRET: secret, NODE_ENV: "test" }),
    argus: {} as never,
  });
}

async function listen(app: ReturnType<typeof appWith>): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetLogTransport();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** Espera o evento `finish` do servidor, que escreve a linha de acesso. */
async function settle(out: { lines: () => Line[] }): Promise<void> {
  // A linha de acesso é escrita no evento `finish`, depois da resposta chegar
  // ao cliente. Espera a saída parar de crescer em vez de um atraso fixo, que
  // sob carga da máquina podia terminar antes da linha existir.
  let previous = -1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = out.lines().length;
    if (current === previous) return;
    previous = current;
  }
}

describe("HTTP observability", () => {
  it("echoes a safe client request id and rejects an unsafe one", async () => {
    const base = await listen(appWith(async () => ({}) as never));
    const kept = await fetch(`${base}/health`, {
      headers: { "x-request-id": "k6-vu1-it2-3" },
    });
    expect(kept.headers.get("x-request-id")).toBe("k6-vu1-it2-3");
    const replaced = await fetch(`${base}/health`, {
      headers: { "x-request-id": 'bad id with spaces"<script>' },
    });
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("returns x-trace-id when a sampled trace is active and exposes it to browsers", async () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.SAMPLED,
      }),
      setAttribute: () => undefined,
    } as never);
    const base = await listen(appWith(async () => ({}) as never));
    const response = await fetch(`${base}/api/v1/nope`, {
      headers: { origin: "http://frontend.test" },
    });
    expect(response.headers.get("x-trace-id")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Request-Id,X-Trace-Id",
    );
  });

  it("allows the W3C trace context headers in CORS preflight", async () => {
    const base = await listen(appWith(async () => ({}) as never));
    const response = await fetch(`${base}/api/v1/incidents`, {
      method: "OPTIONS",
      headers: {
        origin: "http://frontend.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "traceparent,x-request-id",
      },
    });
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("traceparent");
    expect(allowed.toLowerCase()).toContain("x-request-id");
  });

  it("logs one access line per request with a level that follows the status", async () => {
    const base = await listen(
      appWith(async () => {
        throw new ServiceError(
          503,
          "DATA_UNAVAILABLE",
          "Nenhuma versão ativa.",
        );
      }),
    );
    const out = captureStdout();
    try {
      await fetch(`${base}/health`);
      await fetch(`${base}/metrics`);
      await fetch(`${base}/api/v1/nope`, {
        headers: { "x-request-id": "r-404" },
      });
      await fetch(`${base}/api/v1/dashboard/overview`, {
        headers: { "x-request-id": "r-503" },
      });
      await settle(out);
    } finally {
      out.restore();
    }
    const access = out
      .lines()
      .filter((line) => line.event === "http.request.completed");

    expect(access.map((line) => line.request_id)).toEqual(["r-404", "r-503"]);
    expect(access[0]).toMatchObject({
      level: "warn",
      status: 404,
      route: "unmatched",
      path: "/api/v1/nope",
      error_code: "RESOURCE_NOT_FOUND",
    });
    expect(access[1]).toMatchObject({
      level: "error",
      status: 503,
      route: "/api/v1/dashboard/overview",
      error_code: "DATA_UNAVAILABLE",
    });
    expect(typeof access[1]?.duration_ms).toBe("number");
    // Um 503 deliberado não duplica a linha com pilha.
    expect(
      out.lines().some((line) => line.event === "http.request.failed"),
    ).toBe(false);
  });

  it("logs the cause and stack of an unexpected failure without leaking secrets", async () => {
    const base = await listen(
      appWith(async () => {
        throw new Error(
          "dynamo down, retry with token=abc123 for jane@globoplay.com",
        );
      }),
    );
    const out = captureStdout();
    try {
      const response = await fetch(`${base}/api/v1/dashboard/overview`, {
        headers: { "x-request-id": "r-500" },
      });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Falha interna na API.");
      await settle(out);
    } finally {
      out.restore();
    }
    const failed = out
      .lines()
      .find((line) => line.event === "http.request.failed");
    expect(failed).toMatchObject({
      level: "error",
      request_id: "r-500",
      route: "/api/v1/dashboard/overview",
    });
    const error = failed?.error as { message: string; stack: string };
    expect(error.message).toBe(
      "dynamo down, retry with token=[REDACTED] for j***@globoplay.com",
    );
    expect(error.stack).toContain("dynamo down");
    expect(JSON.stringify(out.lines())).not.toContain("abc123");
    expect(JSON.stringify(out.lines())).not.toContain("jane@");
  });

  it("keeps parse errors out of the error log", async () => {
    const base = await listen(appWith(async () => ({}) as never));
    const out = captureStdout();
    try {
      const response = await fetch(`${base}/api/v1/telemetry/rum`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(response.status).toBe(400);
      await settle(out);
    } finally {
      out.restore();
    }
    expect(
      out.lines().some((line) => line.event === "http.request.failed"),
    ).toBe(false);
  });
});

describe("audit and security events", () => {
  const auth = createAuthModule({
    AUTH_COOKIE_SECRET: secret,
    NODE_ENV: "test",
  });
  const session = `session=${auth.sessions.issue({
    id: "reviewer-7",
    email: "reviewer@globoplay.com",
    name: null,
    role: "engineer",
  })}`;

  function appWithIncidents(incidents: Record<string, unknown>) {
    return createApp({
      config: {
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        frontendOrigins: ["http://frontend.test"],
        metricsEnabled: true,
        rateLimitPerMinute: 10_000,
        authLoginRateLimitPerMinute: 10_000,
      },
      incidents: incidents as never,
      dashboard: {} as never,
      imports: importFixture().useCases,
      auth,
      argus: {} as never,
    });
  }

  it("audits a hypothesis review with the reviewer id but never the free-text note", async () => {
    const base = await listen(
      appWithIncidents({
        review: async () => ({
          data: {
            incidentId: "inc-1",
            hypothesisId: "hyp-1",
            review: {
              status: "confirmed",
              note: "contains jane@globoplay.com",
              reviewedAt: "2026-10-05T12:00:00.000Z",
              version: 2,
            },
          },
          datasetVersion: `dsv_${"a".repeat(64)}`,
          quality: {
            window: null,
            partial: false,
            refreshAfterSeconds: null,
            freshness: [],
            warnings: [],
          },
        }),
      }),
    );
    const out = captureStdout();
    try {
      const response = await fetch(
        `${base}/api/v1/incidents/inc-1/hypotheses/hyp-1/review`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: session,
            "x-request-id": "r-review",
          },
          body: JSON.stringify({
            status: "confirmed",
            note: "contains jane@globoplay.com",
            expectedVersion: 1,
          }),
        },
      );
      expect(response.status).toBe(200);
      await settle(out);
    } finally {
      out.restore();
    }
    const audit = out
      .lines()
      .find((line) => line.event === "hypothesis.review.submitted");
    expect(audit).toMatchObject({
      level: "info",
      request_id: "r-review",
      incident_id: "inc-1",
      hypothesis_id: "hyp-1",
      status: "confirmed",
      reviewer_id: "reviewer-7",
    });
    expect(JSON.stringify(out.lines())).not.toContain("jane@");
  });

  it("audits an accepted reanalysis request", async () => {
    const base = await listen(
      appWithIncidents({ reanalyze: async () => undefined }),
    );
    const out = captureStdout();
    try {
      const response = await fetch(`${base}/api/v1/incidents/inc-9/reanalyze`, {
        method: "POST",
        headers: {
          cookie: session,
          "idempotency-key": "idem-0123456789abcdef",
        },
      });
      expect(response.status).toBe(202);
      await settle(out);
    } finally {
      out.restore();
    }
    expect(
      out.lines().find((line) => line.event === "reanalysis.requested"),
    ).toMatchObject({
      incident_id: "inc-9",
      requested_by: "reviewer-7",
    });
  });

  it("counts a failed login by reason without logging the typed credentials", async () => {
    const base = await listen(appWithIncidents({}));
    const out = captureStdout();
    try {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "r-login",
        },
        body: JSON.stringify({
          username: "someone@globoplay.com",
          password: "Hunter2-NEVER-LOG-ME",
        }),
      });
      expect(response.status).toBe(503);
      await settle(out);
    } finally {
      out.restore();
    }
    const failed = out
      .lines()
      .find((line) => line.event === "auth.login.failed");
    expect(failed).toMatchObject({
      level: "warn",
      reason: "unavailable",
      request_id: "r-login",
    });
    const serialized = JSON.stringify(out.lines());
    expect(serialized).not.toContain("Hunter2");
    expect(serialized).not.toContain("someone@");

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(
      /auth_login_attempts_total\{service_name="[^"]+",outcome="unavailable"\} 1/,
    );
  });
});

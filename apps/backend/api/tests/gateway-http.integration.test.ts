import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.ts";
import type { DashboardReadRepository } from "../src/modules/dashboard/ports/dashboard-read-repository.ts";
import { ImportUseCases } from "../src/modules/imports/application/import-use-cases.ts";
import type { ImportControlPort } from "../src/modules/imports/ports/import-control.ts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.ts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.ts";
import type { IncidentRepository } from "../src/modules/incidents/ports/incident-repository.ts";

const servers: Server[] = [];
const secret = "x".repeat(32);

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function requestRawPath(
  url: string,
  path: string,
  currentRequestId: string,
): Promise<{
  readonly status: number;
  readonly requestId: string | string[] | undefined;
  readonly body: unknown;
}> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        headers: { "x-request-id": currentRequestId },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              requestId: response.headers["x-request-id"],
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

const emptyIncidentRepository: IncidentRepository = {
  async listBetween() {
    return [];
  },
  async bundle() {
    return { incident: null, children: [] };
  },
  async writeReview() {
    return {};
  },
};

function buildApp(
  overrides: {
    readonly incidents?: IncidentRepository;
    readonly dashboard?: DashboardReadRepository;
    readonly frontendOrigins?: readonly string[];
    readonly metricsEnabled?: boolean;
    readonly imports?: ImportControlPort;
  } = {},
) {
  const incidents = new IncidentUseCases(
    overrides.incidents ?? emptyIncidentRepository,
    new CursorCodec(secret),
    new UnavailableReviewFeedbackPort(),
  );
  const dashboard = new DashboardQueries(
    overrides.dashboard ?? {
      async latestOverview() {
        return null;
      },
      async latestMonitoring() {
        return null;
      },
    },
    ["argus"],
  );
  return createApp({
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      frontendOrigins: overrides.frontendOrigins ?? ["http://frontend.test"],
      metricsEnabled: overrides.metricsEnabled ?? true,
    },
    incidents,
    dashboard,
    imports: new ImportUseCases(
      overrides.imports ?? {
        async start() {
          return "unavailable";
        },
        async complete() {
          return "unavailable";
        },
        async get() {
          return "unavailable";
        },
      },
    ),
    auth: createAuthModule({ AUTH_COOKIE_SECRET: secret, NODE_ENV: "test" }),
  });
}

describe("api monolith over HTTP", () => {
  it("returns authenticated session details through the public success envelope", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_1",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const url = await listen(buildApp());
    const response = await fetch(`${url}/auth/session`, {
      headers: { cookie: `session=${session}`, "x-request-id": "req_session" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      data: { authenticated: true },
      meta: { requestId: "req_session" },
    });
    // Igualdade exata: o contrato usa additionalProperties: false em `user`.
    expect(body.data.user).toEqual({
      id: "usr_1",
      name: "Engineer",
      email: "engineer@example.test",
      role: "engineer",
      issuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/),
    });
  });

  it("exposes the federated routes and direct password login", async () => {
    const url = await listen(buildApp());
    expect((await fetch(`${url}/auth/login`)).status).toBe(503);
    expect((await fetch(`${url}/auth/callback`)).status).toBe(400);
    expect(
      (await fetch(`${url}/auth/callback?code=code_1&state=state_1`)).status,
    ).toBe(503);

    // POST /auth/login existe: valida o corpo antes de tudo...
    expect((await fetch(`${url}/auth/login`, { method: "POST" })).status).toBe(
      400,
    );
    // ...e falha fechada com 503 enquanto o provedor Cognito não está
    // configurado no ambiente.
    const attempt = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "engineer@example.test",
        password: "irrelevante",
      }),
    });
    expect(attempt.status).toBe(503);
    expect(await attempt.json()).toMatchObject({
      error: { code: "FEATURE_UNAVAILABLE" },
    });
  });

  it("calls a module in-process, wraps quality metadata, and keeps physical fields private", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_1",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const url = await listen(buildApp());
    const response = await fetch(`${url}/api/v1/incidents?window=30m`, {
      headers: {
        "x-request-id": "req_integration",
        origin: "http://frontend.test",
        cookie: `session=${encodeURIComponent(session)}`,
      },
    });
    const body = (await response.json()) as {
      data: unknown;
      meta: {
        requestId: string;
        partial: boolean;
        warnings: Array<{ code: string }>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      requestId: "req_integration",
      partial: true,
    });
    expect(body.meta.warnings[0]?.code).toBe("IMPACT_MEASUREMENT_UNAVAILABLE");
    expect(JSON.stringify(body.data)).not.toMatch(
      /"(?:pk|sk|ttl|LastEvaluatedKey)"/,
    );
  });

  it("returns cheap health, stable validation, CORS, dependency errors, and metrics", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_1",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const cookie = `session=${encodeURIComponent(session)}`;
    const url = await listen(
      buildApp({ frontendOrigins: ["http://allowed.test"] }),
    );
    expect(await (await fetch(`${url}/health`)).json()).toEqual({
      status: "ok",
    });
    const invalid = await fetch(`${url}/api/v1/incidents?limit=1000`);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as object).toHaveProperty("error.requestId");
    expect(
      (await fetch(`${url}/api/v1/dashboard/overview`, { headers: { cookie } }))
        .status,
    ).toBe(503);
    expect(
      (
        await fetch(`${url}/api/v1/incidents`, {
          headers: { origin: "http://forbidden.test" },
        })
      ).status,
    ).toBe(403);
    const metrics = await fetch(`${url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain(
      'http_requests_total{service_name="view-show-api"',
    );

    const rum = await fetch(`${url}/api/v1/telemetry/rum`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://allowed.test",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        name: "frontend_web_vitals_lcp_seconds",
        value: 1.25,
        unit: "seconds",
        metricId: "v1-test",
        path: "/incidentes",
        navigationType: "navigate",
        occurredAt: "2026-09-10T12:00:00.000Z",
        rating: "good",
      }),
    });
    expect(rum.status).toBe(202);
    const updatedMetrics = await fetch(`${url}/metrics`);
    const updatedMetricsBody = await updatedMetrics.text();
    expect(updatedMetricsBody).toContain(
      'frontend_web_vitals_lcp_seconds_count{service_name="view-show-frontend",path="/incidentes",rating="good"} 1',
    );
    expect(updatedMetricsBody).toContain(
      'frontend_web_vitals_lcp_seconds_bucket{le="2.5",service_name="view-show-frontend",path="/incidentes",rating="good"} 1',
    );

    const invalidRum = await fetch(`${url}/api/v1/telemetry/rum`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        name: "arbitrary_metric",
        value: 1,
        unit: "count",
        path: "/",
        occurredAt: "2026-09-10T12:00:00.000Z",
      }),
    });
    expect(invalidRum.status).toBe(400);
  });

  it("assigns the request id before CORS and JSON parsing can fail", async () => {
    const url = await listen(
      buildApp({ frontendOrigins: ["http://allowed.test"] }),
    );

    const forbidden = await fetch(`${url}/api/v1/incidents`, {
      headers: {
        origin: "http://forbidden.test",
        "x-request-id": "req_forbidden_origin",
      },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("x-request-id")).toBe("req_forbidden_origin");
    expect(await forbidden.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        requestId: "req_forbidden_origin",
      },
    });

    const malformedJson = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_malformed_json",
      },
      body: '{"fileName":',
    });
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.headers.get("x-request-id")).toBe(
      "req_malformed_json",
    );
    expect(await malformedJson.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        requestId: "req_malformed_json",
      },
    });
  });

  it("returns validation envelopes for every invalid incident path id", async () => {
    const invalidId = "x".repeat(257);
    const url = await listen(buildApp());
    const requests: readonly [string, RequestInit?][] = [
      [`/api/v1/incidents/${invalidId}/diagnosis`],
      [`/api/v1/incidents/${invalidId}/events`],
      [`/api/v1/incidents/inc_1/events/${invalidId}`],
      [
        `/api/v1/incidents/${invalidId}/hypotheses/hyp_1/review`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "confirmed", expectedVersion: 0 }),
        },
      ],
      [
        `/api/v1/incidents/inc_1/hypotheses/${invalidId}/review`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "confirmed", expectedVersion: 0 }),
        },
      ],
    ];

    for (const [path, init] of requests) {
      const response = await fetch(`${url}${path}`, init);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
  });

  it("returns validation envelopes when Express cannot decode route parameters", async () => {
    const url = await listen(buildApp());

    for (const [path, currentRequestId] of [
      ["/api/v1/incidents/%/diagnosis", "req_bad_incident_encoding"],
      ["/api/v1/incidents/inc_1/events/%", "req_bad_event_encoding"],
      ["/api/v1/imports/%", "req_bad_import_encoding"],
    ] as const) {
      const response = await requestRawPath(url, path, currentRequestId);
      expect(response.status, path).toBe(400);
      expect(response.requestId, path).toBe(currentRequestId);
      expect(response.body, path).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          requestId: currentRequestId,
        },
      });
    }
  });

  it("treats malformed cookie encoding as an invalid session", async () => {
    const url = await listen(buildApp());

    for (const [path, init] of [
      ["/auth/session", undefined],
      [
        "/api/v1/incidents/inc_1/hypotheses/hyp_1/review",
        {
          method: "PATCH",
          headers: {
            cookie: "session=%",
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: "confirmed", expectedVersion: 0 }),
        },
      ],
    ] satisfies readonly [string, RequestInit | undefined][]) {
      const response = await fetch(`${url}${path}`, {
        ...init,
        headers: { ...init?.headers, cookie: "session=%" },
      });
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toMatchObject({
        error: { code: "UNAUTHENTICATED" },
      });
    }
  });

  it("surfaces a module DATA_UNAVAILABLE as a 503 envelope", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_1",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const url = await listen(
      buildApp({ frontendOrigins: [], metricsEnabled: false }),
    );
    const response = await fetch(`${url}/api/v1/dashboard/overview`, {
      headers: { cookie: `session=${encodeURIComponent(session)}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty(
      "error.code",
      "DATA_UNAVAILABLE",
    );
  });

  it("validates and authenticates import routes before calling the unavailable control", async () => {
    let calls = 0;
    const control: ImportControlPort = {
      async start() {
        calls += 1;
        return "unavailable";
      },
      async complete() {
        calls += 1;
        return "unavailable";
      },
      async get() {
        calls += 1;
        return "unavailable";
      },
    };
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_e2e",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const headers = { cookie: `session=${encodeURIComponent(session)}` };
    const url = await listen(buildApp({ imports: control }));
    const start = {
      fileName: "argus.sql.gz",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      partCount: 1,
    };

    expect(
      (await fetch(`${url}/api/v1/imports`, { method: "POST" })).status,
    ).toBe(400);
    expect(calls).toBe(0);
    expect(
      (
        await fetch(`${url}/api/v1/imports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(start),
        })
      ).status,
    ).toBe(401);
    expect(calls).toBe(0);
    expect(
      (
        await fetch(`${url}/api/v1/imports`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ ...start, sha256: "invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
    const started = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(start),
    });
    expect(started.status).toBe(503);
    expect(await started.json()).toMatchObject({
      error: { code: "FEATURE_UNAVAILABLE" },
    });
    expect(calls).toBe(1);

    const duplicateParts = await fetch(`${url}/api/v1/imports/imp_1/complete`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 1, etag: "etag-2" },
        ],
      }),
    });
    expect(duplicateParts.status).toBe(400);
    expect(calls).toBe(1);
    expect(
      (
        await fetch(`${url}/api/v1/imports/imp_1/complete`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag-1" }] }),
        })
      ).status,
    ).toBe(503);
    expect(calls).toBe(2);
    expect(
      (await fetch(`${url}/api/v1/imports/imp_1`, { headers })).status,
    ).toBe(503);
    expect(calls).toBe(3);
  });

  it("validates authenticated reanalysis requests and fails closed without a publisher", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_1",
      email: "engineer@example.test",
      name: "Engineer",
      role: "engineer",
    });
    const headers = {
      cookie: `session=${encodeURIComponent(session)}`,
      "idempotency-key": "rea_key",
    };
    const url = await listen(
      buildApp({
        incidents: {
          ...emptyIncidentRepository,
          async bundle(incidentId) {
            return {
              incident:
                incidentId === "inc_known"
                  ? {
                      itemType: "incident",
                      id: "inc_known",
                      title: "Known incident",
                      priority: "P1",
                      status: "investigating",
                      startedAt: "2026-01-01T12:00:00Z",
                    }
                  : null,
              children: [],
            };
          },
        },
      }),
    );

    expect(
      (
        await fetch(`${url}/api/v1/incidents/${"x".repeat(257)}/reanalyze`, {
          method: "POST",
          headers: { "idempotency-key": "rea_key" },
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: { "idempotency-key": "x".repeat(129) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: { "idempotency-key": "rea_key" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ unexpected: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: { ...headers, "content-type": "text/plain" },
          body: "reanalysis requested",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/jsonx" },
          body: "reanalysis requested",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_known/reanalyze`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json-patch+json",
          },
          body: "reanalysis requested",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/incidents/inc_missing/reanalyze`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
    const unavailable = await fetch(
      `${url}/api/v1/incidents/inc_known/reanalyze`,
      { method: "POST", headers },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "FEATURE_UNAVAILABLE" },
    });
  });
});

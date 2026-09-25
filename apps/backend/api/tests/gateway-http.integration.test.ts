import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  completeImportBodySchema,
  importInProgressErrorSchema,
  importSnapshotSchema,
  ServiceError,
} from "@view-show/contracts";
import { createApp } from "../src/app.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.ts";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../src/modules/datasets/ports/active-dataset-resolver.ts";
import type { DashboardReadRepository } from "../src/modules/dashboard/ports/dashboard-read-repository.ts";
import {
  importFixture,
  checksum,
  startInput,
} from "./support/import-fixture.ts";
import type { ImportControlPort } from "../src/modules/imports/ports/import-control.ts";
import { ArgusLiveSyncUseCases } from "../src/modules/argus/application/argus-live-sync-use-cases.ts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.ts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.ts";
import type { IncidentRepository } from "../src/modules/incidents/ports/incident-repository.ts";

const servers: Server[] = [];
const secret = "x".repeat(32);
const unavailableEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.literal("DATA_UNAVAILABLE"),
        message: z.string().min(1),
        requestId: z.literal("req_import_regression"),
      })
      .strict(),
  })
  .strict();

async function importHttpFixture() {
  const fixture = importFixture();
  const auth = createAuthModule({
    AUTH_COOKIE_SECRET: secret,
    NODE_ENV: "test",
  });
  const session = auth.sessions.issue({
    id: "usr_owner",
    email: "owner@example.test",
    name: "Owner",
    role: "engineer",
  });
  return {
    fixture,
    url: await listen(buildApp({ imports: fixture.useCases })),
    headers: {
      cookie: `session=${encodeURIComponent(session)}`,
      "content-type": "application/json",
      "idempotency-key": "http-regression",
      "x-request-id": "req_import_regression",
    },
  };
}
const activeDataset: ActiveDatasetSnapshot = {
  datasetVersion: `dsv_${"a".repeat(64)}`,
  formulaVersions: {
    events: "1.0",
    evidence: "1.0",
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
  },
  projectionVersions: {
    events: "1.0",
    evidence: "1.0",
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
  },
};

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
  async activeProjection() {
    return null;
  },
  async listBetween() {
    return [];
  },
  async bundle() {
    return { incident: null, children: [] };
  },
  async eventProjection() {
    return null;
  },
  async listEvents() {
    return {
      items: [],
      categoryStats: [],
      facets: {
        categories: [],
        sourceDatasets: [],
        correlationStatuses: [],
      },
      next: null,
    };
  },
  async getEvent() {
    return null;
  },
  async listEvidence() {
    return [];
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
    readonly activeDataset?: ActiveDatasetResolver;
    readonly argus?: ArgusLiveSyncUseCases;
  } = {},
) {
  const active =
    overrides.activeDataset ??
    ({
      resolve: vi.fn(async () => activeDataset),
    } satisfies ActiveDatasetResolver);
  const incidents = new IncidentUseCases(
    overrides.incidents ?? emptyIncidentRepository,
    active,
    new CursorCodec(secret),
    new UnavailableReviewFeedbackPort(),
  );
  const dashboard = new DashboardQueries(
    overrides.dashboard ?? {
      async activeOverview() {
        return null;
      },
      async latestMonitoring() {
        return null;
      },
    },
    active,
    ["argus"],
  );
  const argus =
    overrides.argus ??
    new ArgusLiveSyncUseCases(
      { read: async () => false, write: async () => undefined },
      { setEnabled: async () => undefined },
    );
  const dependencies = {
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      frontendOrigins: overrides.frontendOrigins ?? ["http://frontend.test"],
      metricsEnabled: overrides.metricsEnabled ?? true,
      rateLimitPerMinute: 10_000,
    },
    incidents,
    dashboard,
    imports: overrides.imports ?? importFixture().useCases,
    auth: createAuthModule({ AUTH_COOKIE_SECRET: secret, NODE_ENV: "test" }),
    argus,
  };
  return createApp(dependencies);
}

describe("api monolith over HTTP", () => {
  it("allows any authenticated session to activate a READY import", async () => {
    const imports = importFixture().useCases as ImportControlPort & {
      activate: ReturnType<typeof vi.fn>;
    };
    imports.activate = vi.fn(async (input) => ({
      data: {
        importId: input.importId,
        datasetVersion: `dsv_${"a".repeat(64)}`,
        activatedAt: "2026-09-17T10:04:00.000Z",
        activatedBy: input.requestedBy,
        changed: true,
      },
      datasetVersion: null,
      quality: {
        window: null,
        partial: false,
        refreshAfterSeconds: null,
        freshness: [],
        warnings: [],
      },
    }));
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_viewer",
      email: "viewer@example.test",
      name: "Viewer",
      role: "viewer",
    });
    const url = await listen(buildApp({ imports }));
    const importId = "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3";

    const response = await fetch(`${url}/api/v1/imports/${importId}/activate`, {
      method: "POST",
      headers: {
        cookie: `session=${encodeURIComponent(session)}`,
        "content-type": "application/json",
        "idempotency-key": "activate-http",
        "x-request-id": "req_activate_http",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        importId,
        datasetVersion: `dsv_${"a".repeat(64)}`,
        activatedBy: "usr_viewer",
      },
      meta: { requestId: "req_activate_http" },
    });
    expect(imports.activate).toHaveBeenCalledWith({
      importId,
      requestedBy: "usr_viewer",
      idempotencyKey: "activate-http",
    });

    const invalidResponse = await fetch(
      `${url}/api/v1/imports/${importId}/activate`,
      {
        method: "POST",
        headers: {
          cookie: `session=${encodeURIComponent(session)}`,
          "content-type": "application/json",
          "idempotency-key": "activate-invalid-body",
        },
        body: JSON.stringify({ force: true }),
      },
    );
    expect(invalidResponse.status).toBe(400);
    expect(imports.activate).toHaveBeenCalledTimes(1);
  });

  it("lets every authenticated role read and set ARGUS live sync through request-correlated envelopes", async () => {
    let enabled = false;
    const writes: boolean[] = [];
    const argus = new ArgusLiveSyncUseCases(
      {
        read: async () => enabled,
        write: async (next) => {
          writes.push(next);
          enabled = next;
        },
      },
      { setEnabled: async () => undefined },
    );
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const url = await listen(buildApp({ argus }));

    for (const [role, next] of [
      ["viewer", true],
      ["engineer", false],
      ["admin", true],
    ] as const) {
      const session = auth.sessions.issue({
        id: `usr_${role}`,
        email: `${role}@example.test`,
        name: role,
        role,
      });
      const response = await fetch(`${url}/api/v1/integrations/argus`, {
        method: "PATCH",
        headers: {
          cookie: `session=${encodeURIComponent(session)}`,
          "content-type": "application/json",
          "x-request-id": `req_argus_${role}`,
        },
        body: JSON.stringify({ enabled: next }),
      });

      expect(response.status, role).toBe(200);
      expect(await response.json(), role).toMatchObject({
        data: { enabled: next },
        meta: {
          datasetVersion: null,
          requestId: `req_argus_${role}`,
        },
      });
    }

    expect(writes).toEqual([true, false, true]);
    const session = auth.sessions.issue({
      id: "usr_viewer",
      email: "viewer@example.test",
      name: "Viewer",
      role: "viewer",
    });
    const read = await fetch(`${url}/api/v1/integrations/argus`, {
      headers: {
        cookie: `session=${encodeURIComponent(session)}`,
        "x-request-id": "req_argus_read",
      },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      data: { enabled: true },
      meta: { datasetVersion: null, requestId: "req_argus_read" },
    });
  });

  it("rejects anonymous ARGUS access, validates the exact update body, and safely surfaces control failures", async () => {
    const auth = createAuthModule({
      AUTH_COOKIE_SECRET: secret,
      NODE_ENV: "test",
    });
    const session = auth.sessions.issue({
      id: "usr_viewer",
      email: "viewer@example.test",
      name: "Viewer",
      role: "viewer",
    });
    const unavailableArgus = new ArgusLiveSyncUseCases(
      {
        read: async () => {
          throw new Error("dynamodb unavailable");
        },
        write: async () => {
          throw new Error("dynamodb unavailable");
        },
      },
      { setEnabled: async () => undefined },
    );
    const url = await listen(buildApp({ argus: unavailableArgus }));

    expect((await fetch(`${url}/api/v1/integrations/argus`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/v1/integrations/argus`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: "yes" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/v1/integrations/argus`, {
          method: "PATCH",
          headers: {
            cookie: `session=${encodeURIComponent(session)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: true, actor: "usr_viewer" }),
        })
      ).status,
    ).toBe(400);
    for (const init of [
      { method: "GET" },
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    ] as const) {
      const response = await fetch(`${url}/api/v1/integrations/argus`, {
        ...init,
        headers: {
          ...init.headers,
          cookie: `session=${encodeURIComponent(session)}`,
        },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });
    }
  });
  it.each(["2026-02-30", "2026-13-01", "0000-01-01", "2026-02-29"])(
    "rejects impossible civil date %s before creating an import",
    async (snapshotExtractedOn) => {
      const { fixture, url, headers } = await importHttpFixture();
      const response = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName: "argus_dump.sql.gz",
          sizeBytes: 1024,
          snapshotExtractedOn,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
      expect(fixture.store.create).not.toHaveBeenCalled();
    },
  );

  it.each(["2024-02-29", "9999-12-31"])(
    "accepts semantic civil date %s over HTTP",
    async (snapshotExtractedOn) => {
      const { url, headers } = await importHttpFixture();
      const response = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName: "argus_dump.sql.gz",
          sizeBytes: 1024,
          snapshotExtractedOn,
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toHaveProperty(
        "data.snapshotExtractedOn",
        snapshotExtractedOn,
      );
    },
  );

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
      issuedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/,
      ),
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

  it("returns 503 when ACTIVE has no compatible incident projection without reading the legacy model", async () => {
    const listBetween = vi.fn(async () => []);
    const active = { resolve: vi.fn(async () => activeDataset) };
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
      buildApp({
        activeDataset: active,
        incidents: { ...emptyIncidentRepository, listBetween },
      }),
    );
    const response = await fetch(`${url}/api/v1/incidents?window=30m`, {
      headers: {
        "x-request-id": "req_integration",
        origin: "http://frontend.test",
        cookie: `session=${encodeURIComponent(session)}`,
      },
    });
    const body = (await response.json()) as object;
    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: { code: "DATA_UNAVAILABLE", requestId: "req_integration" },
    });
    expect(active.resolve).toHaveBeenCalledTimes(1);
    expect(listBetween).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(
      /"(?:pk|sk|ttl|LastEvaluatedKey)"/,
    );
  });

  it("returns 422 for unsupported incident filters before resolving ACTIVE or reading storage", async () => {
    const listBetween = vi.fn(async () => []);
    const active = { resolve: vi.fn(async () => activeDataset) };
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
      buildApp({
        activeDataset: active,
        incidents: { ...emptyIncidentRepository, listBetween },
      }),
    );

    const response = await fetch(
      `${url}/api/v1/incidents?window=30m&deviceType=smart-tv`,
      { headers: { cookie: `session=${encodeURIComponent(session)}` } },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_FILTER_COMBINATION" },
    });
    expect(active.resolve).not.toHaveBeenCalled();
    expect(listBetween).not.toHaveBeenCalled();
  });

  it("rejects unknown event selectors before ACTIVE and returns 503 for a base query", async () => {
    const bundle = vi.fn(async () => null);
    const active = { resolve: vi.fn(async () => activeDataset) };
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
      buildApp({
        activeDataset: active,
        incidents: { ...emptyIncidentRepository, bundle },
      }),
    );

    const unsupported = await fetch(
      `${url}/api/v1/incidents/inc_1/events?deviceType=smart-tv`,
      { headers: { cookie: `session=${encodeURIComponent(session)}` } },
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(active.resolve).not.toHaveBeenCalled();
    expect(bundle).not.toHaveBeenCalled();

    const unavailable = await fetch(
      `${url}/api/v1/incidents/inc_1/events?window=30m`,
      { headers: { cookie: `session=${encodeURIComponent(session)}` } },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "DATA_UNAVAILABLE" },
    });
    expect(active.resolve).toHaveBeenCalledTimes(1);
    expect(bundle).not.toHaveBeenCalled();
  });

  it("serves the global event feed and event detail from the active projection", async () => {
    const event = {
      id: "evt_a56cfhze7zv2cj2fn5hwc35fm7",
      datasetVersion: activeDataset.datasetVersion,
      category: "signal_observation" as const,
      source: {
        system: "argus",
        dataset: "signal_bucket",
        recordId: '[["id","signal-1"]]',
        canonicalLocator: "canonical://dataset/signal_bucket/signal-1",
      },
      occurredAt: "2026-01-01T11:40:00.000Z",
      window: null,
      dimensions: { source: "video" },
      measures: { value: 8 },
      correlation: {
        status: "unlinked" as const,
        incidentIds: [],
        links: [],
      },
      quality: {
        status: "measured" as const,
        flags: [],
        observedThrough: "2026-01-01T11:45:00.000Z",
      },
      raw: { available: false, reason: "not_materialized_in_event_projection" },
    };
    const listEvents = vi.fn(async () => ({
      items: [event],
      categoryStats: [{ category: event.category, count: 1 }],
      facets: {
        categories: [event.category],
        sourceDatasets: [event.source.dataset],
        correlationStatuses: [event.correlation.status],
      },
      next: null,
    }));
    const getEvent = vi.fn(async () => event);
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
      buildApp({
        incidents: {
          ...emptyIncidentRepository,
          eventProjection: vi.fn(async () => ({
            observedThrough: "2026-01-01T11:45:00.000Z",
            coverage: "complete" as const,
            qualityFlags: [],
          })),
          listEvents,
          getEvent,
        },
      }),
    );
    const headers = { cookie: `session=${encodeURIComponent(session)}` };

    const feed = await fetch(
      `${url}/api/v1/events?from=2026-01-01T11:00:00.000Z&to=2026-01-01T12:00:00.000Z`,
      { headers },
    );
    const detail = await fetch(`${url}/api/v1/events/${event.id}`, { headers });

    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({
      data: { incident: null, items: [{ id: event.id }] },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { id: event.id } });
    expect(listEvents).toHaveBeenCalledWith(
      activeDataset,
      expect.objectContaining({ incidentId: null, correlation: "all" }),
    );
    expect(getEvent).toHaveBeenCalledWith(activeDataset, event.id, null);
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

  it.each([
    { label: "usual S3 ETags", etag: `"${"a".repeat(32)}"`, bytes: 82463 },
    {
      label: "maximum ETag JSON escaping",
      etag: "\u0000".repeat(1024),
      bytes: 3991583,
    },
  ])(
    "completes a 10 GiB ZIP over HTTP with 640 parts and $label",
    async ({ etag, bytes }) => {
      const { fixture, url, headers } = await importHttpFixture();
      const started = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName: "argus.zip",
          sizeBytes: 10737418240,
          snapshotExtractedOn: "2026-09-17",
        }),
      });
      expect(started.status).toBe(201);
      const {
        data: { importId },
      } = (await started.json()) as { data: { importId: string } };
      const manifest = {
        parts: Array.from({ length: 640 }, (_, i) => ({
          partNumber: i + 1,
          etag,
          checksumSha256: checksum,
        })),
      };
      expect(completeImportBodySchema.safeParse(manifest).success).toBe(true);
      const body = JSON.stringify(manifest);
      expect(Buffer.byteLength(body)).toBe(bytes);
      expect(bytes).toBeLessThan(4 * 1024 * 1024);
      const completed = await fetch(
        `${url}/api/v1/imports/${importId}/complete`,
        { method: "POST", headers, body },
      );
      expect(completed.status).toBe(202);
      expect(await completed.json()).toMatchObject({
        data: { importId, state: "UPLOADED", sizeBytes: 10737418240 },
      });
      expect(fixture.store.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: manifest.parts,
          expectedPartCount: 640,
          expectedSizeBytes: 10737418240,
        }),
      );
    },
  );

  it.each([
    { path: "complete", limit: 4 * 1024 * 1024 },
    { path: "start", limit: 64 * 1024 },
  ])(
    "CU-IMP-05: retorna envelope 413 estável acima do limite do parser de $path",
    async ({ path, limit }) => {
      const { fixture, url, headers } = await importHttpFixture();
      const route =
        path === "complete" ? "/imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3/complete" : "";
      const body = JSON.stringify({ padding: "x".repeat(limit) });
      const result = await fetch(`${url}/api/v1/imports${route}`, {
        method: "POST",
        headers,
        body,
      });
      expect(result.status).toBe(413);
      expect(await result.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "O corpo da requisição excede o limite permitido.",
          requestId: "req_import_regression",
        },
      });
      expect(fixture.store.complete).not.toHaveBeenCalled();
      expect(fixture.store.create).not.toHaveBeenCalled();
    },
  );

  it("CU-IMP-01: aplica os limites do GZIP antes de reservar a importação", async () => {
    const limit = 5 * 1024 ** 3;
    const cases = [
      { label: "mínimo válido", sizeBytes: 1, expectedStatus: 201 },
      {
        label: "imediatamente abaixo do máximo",
        sizeBytes: limit - 1,
        expectedStatus: 201,
      },
      { label: "máximo válido", sizeBytes: limit, expectedStatus: 201 },
      {
        label: "imediatamente acima do máximo",
        sizeBytes: limit + 1,
        expectedStatus: 400,
      },
      {
        label: "imediatamente abaixo do mínimo",
        sizeBytes: 0,
        expectedStatus: 400,
      },
      {
        label: "formato não aceito",
        sizeBytes: 1024,
        fileName: "argus_dump.sql",
        expectedStatus: 400,
      },
      {
        label: "data civil inválida",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-02-29",
        expectedStatus: 400,
      },
    ] as const;

    for (const testCase of cases) {
      const { fixture, url, headers } = await importHttpFixture();
      const response = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName:
            "fileName" in testCase ? testCase.fileName : "argus_dump.sql.gz",
          sizeBytes: testCase.sizeBytes,
          snapshotExtractedOn:
            "snapshotExtractedOn" in testCase
              ? testCase.snapshotExtractedOn
              : "2026-09-25",
        }),
      });

      expect(response.status, testCase.label).toBe(testCase.expectedStatus);
      if (testCase.expectedStatus === 201) {
        expect(fixture.store.create, testCase.label).toHaveBeenCalledTimes(1);
        expect(fixture.current(), testCase.label).toMatchObject({
          fileName: "argus_dump.sql.gz",
          sizeBytes: testCase.sizeBytes,
          state: "UPLOADING",
        });
      } else {
        expect(await response.json(), testCase.label).toMatchObject({
          error: { code: "VALIDATION_ERROR" },
        });
        expect(fixture.store.create, testCase.label).not.toHaveBeenCalled();
        expect(fixture.current(), testCase.label).toBeNull();
      }
    }
  });

  it("CU-IMP-02: aplica os limites do ZIP e do nome antes de reservar a importação", async () => {
    const sizeLimit = 10 * 1024 ** 3;
    const maxName = `${"a".repeat(251)}.zip`;
    const cases = [
      {
        label: "mínimo válido",
        fileName: "argus.zip",
        sizeBytes: 1,
        expectedStatus: 201,
      },
      {
        label: "imediatamente abaixo do tamanho máximo",
        fileName: "argus.zip",
        sizeBytes: sizeLimit - 1,
        expectedStatus: 201,
      },
      {
        label: "tamanho máximo válido",
        fileName: "argus.zip",
        sizeBytes: sizeLimit,
        expectedStatus: 201,
      },
      {
        label: "imediatamente acima do tamanho máximo",
        fileName: "argus.zip",
        sizeBytes: sizeLimit + 1,
        expectedStatus: 400,
      },
      {
        label: "nome vazio",
        fileName: ".zip",
        sizeBytes: 1024,
        expectedStatus: 400,
      },
      {
        label: "nome no máximo",
        fileName: maxName,
        sizeBytes: 1024,
        expectedStatus: 201,
      },
      {
        label: "nome imediatamente acima do máximo",
        fileName: `${"a".repeat(252)}.zip`,
        sizeBytes: 1024,
        expectedStatus: 400,
      },
      {
        label: "nome com caminho",
        fileName: "pasta/argus.zip",
        sizeBytes: 1024,
        expectedStatus: 400,
      },
    ] as const;

    for (const testCase of cases) {
      const { fixture, url, headers } = await importHttpFixture();
      const response = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName: testCase.fileName,
          sizeBytes: testCase.sizeBytes,
          snapshotExtractedOn: "2026-09-25",
        }),
      });

      expect(response.status, testCase.label).toBe(testCase.expectedStatus);
      if (testCase.expectedStatus === 201) {
        expect(fixture.store.create, testCase.label).toHaveBeenCalledTimes(1);
        expect(fixture.current(), testCase.label).toMatchObject({
          fileName: testCase.fileName,
          sizeBytes: testCase.sizeBytes,
          state: "UPLOADING",
        });
      } else {
        expect(await response.json(), testCase.label).toMatchObject({
          error: { code: "VALIDATION_ERROR" },
        });
        expect(fixture.store.create, testCase.label).not.toHaveBeenCalled();
        expect(fixture.current(), testCase.label).toBeNull();
      }
    }
  });

  it("CU-IMP-06: terminaliza com segurança quando o multipart não pode ser preparado", async () => {
    const { fixture, url, headers } = await importHttpFixture();
    fixture.store.create.mockRejectedValueOnce(
      new Error("detalhe privado do armazenamento"),
    );

    const response = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fileName: "argus_dump.sql.gz",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-09-25",
      }),
    });
    const envelope = await response.json();

    expect(response.status).toBe(503);
    expect(envelope).toMatchObject({
      error: { code: "UPLOAD_PREPARATION_FAILED" },
    });
    expect(JSON.stringify(envelope)).not.toContain("detalhe privado");
    expect(fixture.current()).toMatchObject({
      state: "FAILED",
      error: { code: "UPLOAD_PREPARATION_FAILED" },
    });
    expect(await fixture.repository.getActive()).toBeNull();
  });

  it.each(["missing", "unavailable"])(
    "CU-IMP-04: retorna 503 seguro quando a disputa tem registro ativo %s",
    async (mode) => {
      const { fixture, url, headers } = await importHttpFixture();
      await fixture.useCases.start(startInput);
      if (mode === "missing")
        vi.spyOn(fixture.repository, "getActive").mockResolvedValueOnce(null);
      else
        vi.spyOn(fixture.repository, "getActive").mockRejectedValueOnce(
          new Error("private database failure"),
        );
      const result = await fetch(`${url}/api/v1/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileName: "argus.zip",
          sizeBytes: 1024,
          snapshotExtractedOn: "2026-09-17",
        }),
      });
      expect(result.status).toBe(503);
      const envelope = await result.json();
      expect(unavailableEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(JSON.stringify(envelope)).not.toContain("private");
    },
  );

  it("never returns 202 when losing restart replay persistence fails", async () => {
    const { fixture, url, headers } = await importHttpFixture();
    const {
      data: { importId },
    } = await fixture.useCases.start(startInput);
    vi.spyOn(fixture.repository, "swapUploadForRestart").mockRejectedValueOnce(
      new ServiceError(409, "IMPORT_STATE_CONFLICT", "race"),
    );
    vi.spyOn(fixture.repository, "recordRestartReplay").mockRejectedValueOnce(
      new Error("private database failure"),
    );
    const result = await fetch(`${url}/api/v1/imports/${importId}/restart`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(result.status).toBe(503);
    expect(
      unavailableEnvelopeSchema.safeParse(await result.json()).success,
    ).toBe(true);
  });

  it("maps unavailable confirmed upload progress to a safe 503 envelope", async () => {
    const { fixture, url, headers } = await importHttpFixture();
    const started = await fixture.useCases.start(startInput);
    fixture.store.getUploadedProgress.mockRejectedValueOnce(
      new Error("private bucket and upload identifier"),
    );

    const result = await fetch(
      `${url}/api/v1/imports/${started.data.importId}`,
      { headers },
    );

    expect(result.status).toBe(503);
    const envelope = await result.json();
    expect(unavailableEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("private");
    expect(JSON.stringify(envelope)).not.toContain("upload identifier");
  });

  it("rejects duplicate completion parts when duplication is the only invalidity", async () => {
    const { fixture, url, headers } = await importHttpFixture();
    const started = await fixture.useCases.start({
      ...startInput,
      sizeBytes: 16 * 1024 * 1024 + 1,
    });

    const result = await fetch(
      `${url}/api/v1/imports/${started.data.importId}/complete`,
      {
        method: "POST",
        headers: { ...headers, "idempotency-key": "duplicate-parts" },
        body: JSON.stringify({
          parts: [
            {
              partNumber: 1,
              etag: "etag-1",
              checksumSha256: checksum,
            },
            {
              partNumber: 1,
              etag: "etag-2",
              checksumSha256: checksum,
            },
          ],
        }),
      },
    );

    expect(result.status).toBe(400);
    expect(fixture.store.complete).not.toHaveBeenCalled();
  });

  it("CU-IMP-03: autentica, garante idempotência e protege a importação ativa", async () => {
    const fixture = importFixture();
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
    const url = await listen(buildApp({ imports: fixture.useCases }));
    const start = {
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
    };

    expect(
      (await fetch(`${url}/api/v1/imports`, { method: "POST" })).status,
    ).toBe(401);
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(
      (
        await fetch(`${url}/api/v1/imports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(start),
        })
      ).status,
    ).toBe(401);
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(
      (
        await fetch(`${url}/api/v1/imports`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ ...start, sha256: "invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(fixture.store.create).not.toHaveBeenCalled();
    const started = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "start-http",
      },
      body: JSON.stringify(start),
    });
    expect(started.status).toBe(201);
    const result = (await started.json()) as { data: { importId: string } };
    expect(result).toMatchObject({
      data: {
        state: "UPLOADING",
        requestedBy: "usr_e2e",
        author: { id: "usr_e2e", name: "Engineer" },
      },
    });
    const importId = result.data.importId;
    expect(fixture.store.create).toHaveBeenCalledTimes(1);
    const replayed = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "start-http",
      },
      body: JSON.stringify(start),
    });
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toMatchObject({ data: { importId } });
    expect(fixture.store.create).toHaveBeenCalledTimes(1);
    const authenticatedJson = {
      ...headers,
      "content-type": "application/json",
    };
    for (const [path, body] of [
      ["", start],
      [`/${importId}/restart`, {}],
      [
        `/${importId}/complete`,
        { parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }] },
      ],
    ] as const) {
      const missingKey = await fetch(`${url}/api/v1/imports${path}`, {
        method: "POST",
        headers: authenticatedJson,
        body: JSON.stringify(body),
      });
      expect(missingKey.status).toBe(400);
      const unauthenticated = await fetch(`${url}/api/v1/imports${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "action",
        },
        body: JSON.stringify(body),
      });
      expect(unauthenticated.status).toBe(401);
    }
    const injectedOwner = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: { ...authenticatedJson, "idempotency-key": "bad-owner" },
      body: JSON.stringify({ ...start, requestedBy: "usr_spoofed" }),
    });
    expect(injectedOwner.status).toBe(400);
    const viewer = auth.sessions.issue({
      id: "usr_viewer",
      email: "viewer@example.test",
      name: "Viewer",
      role: "viewer",
    });
    const viewerHeaders = { cookie: `session=${encodeURIComponent(viewer)}` };
    fixture.store.getUploadedProgress.mockResolvedValue({
      completedBytes: 640,
    });
    const shared = await fetch(`${url}/api/v1/imports/${importId}`, {
      headers: viewerHeaders,
    });
    expect(shared.status).toBe(200);
    const sharedEnvelope = await shared.json();
    expect(sharedEnvelope).toMatchObject({
      data: {
        canManageUpload: false,
        progress: { kind: "bytes", completedBytes: 640, totalBytes: 1024 },
      },
    });
    expect(importSnapshotSchema.safeParse(sharedEnvelope.data).success).toBe(
      true,
    );
    expect(JSON.stringify(sharedEnvelope)).not.toMatch(
      /uploadId|bucket|physicalVersion|etag|checksum|signed|url/i,
    );
    const sharedList = await fetch(`${url}/api/v1/imports`, {
      headers: viewerHeaders,
    });
    const sharedListEnvelope = await sharedList.json();
    expect(sharedListEnvelope).toMatchObject({
      data: {
        items: [
          {
            importId,
            canManageUpload: false,
            progress: { completedBytes: 640, totalBytes: 1024 },
          },
        ],
      },
    });
    expect(JSON.stringify(sharedListEnvelope)).not.toMatch(
      /uploadId|bucket|physicalVersion|etag|checksum|signed|url/i,
    );
    expect(
      (
        await fetch(`${url}/api/v1/imports/${importId}/parts`, {
          headers: viewerHeaders,
        })
      ).status,
    ).toBe(403);
    const conflict = await fetch(`${url}/api/v1/imports`, {
      method: "POST",
      headers: { ...authenticatedJson, "idempotency-key": "other-start" },
      body: JSON.stringify(start),
    });
    expect(conflict.status).toBe(409);
    const conflictEnvelope = await conflict.json();
    expect(
      importInProgressErrorSchema.safeParse(conflictEnvelope).success,
    ).toBe(true);
    expect(conflictEnvelope).toMatchObject({
      error: { code: "IMPORT_IN_PROGRESS", details: { importId } },
    });

    for (const path of ["", `/${importId}`, `/${importId}/parts`]) {
      expect(
        (await fetch(`${url}/api/v1/imports${path}`, { headers })).status,
      ).toBe(200);
    }
    const signed = await fetch(`${url}/api/v1/imports/${importId}/parts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ partNumber: 1, checksumSha256: checksum }],
      }),
    });
    expect(signed.status).toBe(200);
    const restarted = await fetch(`${url}/api/v1/imports/${importId}/restart`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "restart-http",
      },
      body: "{}",
    });
    expect(restarted.status).toBe(202);
    const completionBody = {
      parts: [{ partNumber: 1, etag: "etag-1", checksumSha256: checksum }],
    };
    const complete = (
      idempotencyKey: string,
      body = completionBody,
      owner = headers,
    ) =>
      fetch(`${url}/api/v1/imports/${importId}/complete`, {
        method: "POST",
        headers: {
          ...owner,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    expect((await complete("complete-http")).status).toBe(202);
    expect((await complete("complete-http")).status).toBe(202);
    const changedManifest = await complete("complete-http", {
      parts: [{ ...completionBody.parts[0], etag: "different" }],
    });
    expect(changedManifest.status).toBe(409);
    const ownerConflict = await complete(
      "complete-http",
      completionBody,
      viewerHeaders,
    );
    expect(ownerConflict.status).toBe(409);
    expect((await complete("complete-http-later")).status).toBe(202);
    const changedLaterManifest = await complete("complete-http-later", {
      parts: [{ ...completionBody.parts[0], etag: "different" }],
    });
    expect(changedLaterManifest.status).toBe(409);
    expect(
      JSON.stringify([
        await changedManifest.json(),
        await ownerConflict.json(),
        await changedLaterManifest.json(),
      ]),
    ).not.toMatch(
      /fingerprint|completion-key|uploadId|bucket|physicalVersion/i,
    );
    expect(fixture.store.complete).toHaveBeenCalledTimes(1);
    expect(
      (await fetch(`${url}/api/v1/imports/${importId}`, { headers })).status,
    ).toBe(200);
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
    ).toBe(503);
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

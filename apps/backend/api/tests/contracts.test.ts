import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ServiceError,
  assertNoPhysicalFields,
  authCallbackQuerySchema,
  completeImportBodySchema,
  errorEnvelope,
  incidentsQuerySchema,
  responseMetaSchema,
  reviewBodySchema,
  startImportBodySchema,
  successEnvelope,
} from "@view-show/contracts";
import { createApp } from "../src/app.ts";
import { PUBLIC_ROUTES } from "../src/http/public-routes.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.ts";
import { ImportUseCases } from "../src/modules/imports/application/import-use-cases.ts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.ts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.ts";

const architectureOperations = [
  "GET /auth/session",
  "GET /auth/login",
  "GET /auth/callback",
  "POST /auth/logout",
  "POST /api/v1/imports",
  "POST /api/v1/imports/{importId}/complete",
  "GET /api/v1/imports/{importId}",
  "GET /api/v1/dashboard/overview",
  "GET /api/v1/incidents",
  "GET /api/v1/incidents/{incidentId}/diagnosis",
  "PATCH /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review",
  "GET /api/v1/incidents/{incidentId}/events",
  "GET /api/v1/incidents/{incidentId}/events/{eventId}",
  "GET /api/v1/monitoring/overview",
  "POST /api/v1/incidents/{incidentId}/reanalyze",
  "GET /health",
  "GET /metrics",
].sort();
const openApiHttpMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

function buildPublicApp() {
  const incident = {
    itemType: "incident",
    id: "sample",
    title: "Sample incident",
    priority: "P1",
    status: "investigating",
    startedAt: "2026-01-01T12:00:00Z",
  };
  const incidents = new IncidentUseCases(
    {
      async listBetween() {
        return [];
      },
      async bundle() {
        return { incident, children: [] };
      },
      async writeReview() {
        return {};
      },
    },
    new CursorCodec("x".repeat(32)),
    new UnavailableReviewFeedbackPort(),
  );
  const dashboard = new DashboardQueries(
    {
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
      frontendOrigins: ["http://frontend.test"],
      metricsEnabled: true,
    },
    incidents,
    dashboard,
    imports: new ImportUseCases({
      async start() {
        return "unavailable";
      },
      async complete() {
        return "unavailable";
      },
      async get() {
        return "unavailable";
      },
    }),
    auth: createAuthModule({
      AUTH_COOKIE_SECRET: "x".repeat(32),
      NODE_ENV: "test",
    }),
  });
}

async function listen(app: ReturnType<typeof buildPublicApp>): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function samplePath(expressPath: string): string {
  return expressPath.replace(/:\w+/g, "sample");
}

describe("versioned contracts", () => {
  it("accepts only code and state in a federated callback", () => {
    expect(
      authCallbackQuerySchema.parse({ code: "code_1", state: "state_1" }),
    ).toEqual({ code: "code_1", state: "state_1" });
    expect(() =>
      authCallbackQuerySchema.parse({
        code: "code_1",
        state: "state_1",
        unexpected: "value",
      }),
    ).toThrow();
  });

  it("validates temporal queries and optimistic review input", () => {
    expect(
      incidentsQuerySchema.parse({ window: "30m", limit: "10" }).limit,
    ).toBe(10);
    expect(() =>
      incidentsQuerySchema.parse({
        window: "30m",
        from: "2026-01-01T00:00:00Z",
      }),
    ).toThrow();
    expect(
      reviewBodySchema.parse({ status: "confirmed", expectedVersion: 4 }),
    ).toEqual({ status: "confirmed", expectedVersion: 4 });
    expect(() => reviewBodySchema.parse({ status: "confirmed" })).toThrow();
    expect(
      startImportBodySchema.parse({
        fileName: "argus.sql.gz",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        partCount: 1,
      }),
    ).toMatchObject({ fileName: "argus.sql.gz" });
    expect(() => startImportBodySchema.parse({ sha256: "invalid" })).toThrow();
    expect(() =>
      completeImportBodySchema.parse({
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 1, etag: "etag-2" },
        ],
      }),
    ).toThrow("partNumber não pode se repetir.");
  });

  it("builds valid success and error envelopes with request ids", () => {
    const success = successEnvelope(
      {
        data: { value: 1 },
        quality: {
          window: null,
          partial: true,
          refreshAfterSeconds: 30,
          freshness: [],
          warnings: [{ code: "PARTIAL", message: "partial" }],
        },
      },
      "req_test",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(responseMetaSchema.parse(success.meta).requestId).toBe("req_test");
    expect(
      errorEnvelope(
        new ServiceError(503, "DATA_UNAVAILABLE", "missing"),
        "req_error",
      ).error,
    ).toMatchObject({ code: "DATA_UNAVAILABLE", requestId: "req_error" });
  });

  it("rejects physical persistence fields recursively", () => {
    expect(() =>
      assertNoPhysicalFields({ items: [{ pk: "secret" }] }),
    ).toThrowError(ServiceError);
    expect(() =>
      assertNoPhysicalFields({ page: { LastEvaluatedKey: {} } }),
    ).toThrowError(ServiceError);
    expect(() =>
      assertNoPhysicalFields({ items: [{ id: "opaque" }] }),
    ).not.toThrow();
  });

  it("keeps the manifest, OpenAPI document, and registered Express routes in parity", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    const manifestOperations = Object.values(PUBLIC_ROUTES)
      .map((route) => `${route.method.toUpperCase()} ${route.openapi}`)
      .sort();
    const openApiOperations = Object.entries(document.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => openApiHttpMethods.has(method))
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

    expect(document.openapi).toBe("3.1.0");
    expect(manifestOperations).toEqual(architectureOperations);
    expect(openApiOperations).toEqual(architectureOperations);

    const listener = await listen(buildPublicApp());
    try {
      for (const route of Object.values(PUBLIC_ROUTES)) {
        const response = await fetch(
          `${listener.url}${samplePath(route.express)}`,
          {
            method: route.method.toUpperCase(),
          },
        );
        expect(
          response.status,
          `${route.method.toUpperCase()} ${route.express}`,
        ).not.toBe(404);
        if (response.headers.get("content-type")?.includes("application/json"))
          expect(await response.json()).not.toMatchObject({
            error: { code: "RESOURCE_NOT_FOUND" },
          });
      }
    } finally {
      await listener.close();
    }
  });

  it("publishes OpenAPI 3.1 for every public gateway operation", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/auth/login",
      "/auth/callback",
      "/auth/logout",
      "/auth/session",
      "/api/v1/dashboard/overview",
      "/api/v1/incidents",
      "/api/v1/incidents/{incidentId}/diagnosis",
      "/api/v1/incidents/{incidentId}/reanalyze",
      "/api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review",
      "/api/v1/incidents/{incidentId}/events",
      "/api/v1/incidents/{incidentId}/events/{eventId}",
      "/api/v1/monitoring/overview",
      "/api/v1/imports",
      "/api/v1/imports/{importId}/complete",
      "/api/v1/imports/{importId}",
      "/health",
      "/metrics",
    ])
      expect(document.paths).toHaveProperty(path);
    const reanalysis = document.paths[
      "/api/v1/incidents/{incidentId}/reanalyze"
    ] as {
      post?: {
        parameters?: readonly {
          readonly name?: string;
          readonly in?: string;
          readonly required?: boolean;
          readonly schema?: {
            readonly minLength?: number;
            readonly maxLength?: number;
          };
        }[];
        requestBody?: unknown;
        responses?: Record<string, unknown>;
      };
    };
    expect(reanalysis.post).toMatchObject({
      security: [{ sessionCookie: [] }],
      responses: {
        "202": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "409": expect.anything(),
        "503": expect.anything(),
      },
    });
    expect(reanalysis.post?.parameters).toContainEqual(
      expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: expect.objectContaining({ minLength: 1, maxLength: 128 }),
      }),
    );
    expect(reanalysis.post).not.toHaveProperty("requestBody");

    const session = document.paths["/auth/session"] as {
      get?: { security?: readonly Record<string, readonly unknown[]>[] };
    };
    const review = document.paths[
      "/api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review"
    ] as {
      patch?: { security?: readonly Record<string, readonly unknown[]>[] };
    };
    expect(session.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(review.patch?.security).toEqual([{ sessionCookie: [] }]);

    for (const path of [
      "/api/v1/incidents/{incidentId}/diagnosis",
      "/api/v1/incidents/{incidentId}/events",
      "/api/v1/incidents/{incidentId}/events/{eventId}",
    ]) {
      const operation = document.paths[path] as {
        get?: { responses?: Record<string, unknown> };
      };
      expect(operation.get?.responses, path).toHaveProperty("400");
    }
  });
});

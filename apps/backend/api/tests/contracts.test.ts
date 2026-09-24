import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { trace, TraceFlags } from "@opentelemetry/api";
import {
  ServiceError,
  argusLiveSyncUpdateSchema,
  assertNoPhysicalFields,
  authCallbackQuerySchema,
  civilDatePatternSources,
  civilDateSchema,
  completeImportBodySchema,
  createLogger,
  errorEnvelope,
  errorCodeSchema,
  eventDtoSchema,
  evidenceDtoSchema,
  eventsDataRuntimeSchema,
  eventsQuerySchema,
  importIdSchema,
  importInProgressErrorSchema,
  importPageSchema,
  importRunStageSchema,
  importSafeErrorSchema,
  importSnapshotSchema,
  importsQuerySchema,
  incidentsQuerySchema,
  restartImportBodySchema,
  responseMetaSchema,
  reviewBodySchema,
  rumTelemetrySchema,
  signImportPartsBodySchema,
  startImportBodySchema,
  successEnvelope,
} from "@view-show/contracts";
import { createApp } from "../src/app.ts";
import { PUBLIC_ROUTES } from "../src/http/public-routes.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { ArgusLiveSyncUseCases } from "../src/modules/argus/application/argus-live-sync-use-cases.ts";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.ts";
import { importFixture } from "./support/import-fixture.ts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.ts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.ts";

const architectureOperations = [
  "GET /auth/session",
  "GET /auth/login",
  "POST /auth/login",
  "GET /auth/callback",
  "POST /auth/logout",
  "GET /api/v1/imports",
  "POST /api/v1/imports",
  "GET /api/v1/imports/{importId}",
  "GET /api/v1/imports/{importId}/parts",
  "POST /api/v1/imports/{importId}/parts",
  "POST /api/v1/imports/{importId}/restart",
  "POST /api/v1/imports/{importId}/complete",
  "POST /api/v1/imports/{importId}/activate",
  "GET /api/v1/dashboard/overview",
  "GET /api/v1/incidents",
  "GET /api/v1/incidents/{incidentId}/diagnosis",
  "PATCH /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review",
  "GET /api/v1/incidents/{incidentId}/events",
  "GET /api/v1/incidents/{incidentId}/events/{eventId}",
  "GET /api/v1/events",
  "GET /api/v1/events/{eventId}",
  "GET /api/v1/monitoring/overview",
  "POST /api/v1/incidents/{incidentId}/reanalyze",
  "GET /api/v1/integrations/argus",
  "PATCH /api/v1/integrations/argus",
  "GET /health",
  "GET /metrics",
  "POST /api/v1/telemetry/rum",
].sort();

async function civilDateCases(): Promise<{
  valid: string[];
  invalid: string[];
}> {
  return JSON.parse(
    await readFile(
      new URL("../contracts/fixtures/civil-date-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { valid: string[]; invalid: string[] };
}

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
  const activeDataset = {
    async resolve() {
      return {
        datasetVersion: `dsv_${"a".repeat(64)}`,
        formulaVersions: { incidents: "1.0" },
        projectionVersions: { incidents: "1.0" },
      } as const;
    },
  };
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
      async activeProjection() {
        return null;
      },
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
    activeDataset,
    new CursorCodec("x".repeat(32)),
    new UnavailableReviewFeedbackPort(),
  );
  const dashboard = new DashboardQueries(
    {
      async activeOverview() {
        return null;
      },
      async latestMonitoring() {
        return null;
      },
    },
    activeDataset,
    ["argus"],
  );
  const dependencies = {
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      frontendOrigins: ["http://frontend.test"],
      metricsEnabled: true,
    },
    incidents,
    dashboard,
    imports: importFixture().useCases,
    auth: createAuthModule({
      AUTH_COOKIE_SECRET: "x".repeat(32),
      NODE_ENV: "test",
    }),
    argus: new ArgusLiveSyncUseCases(
      { read: async () => false, write: async () => undefined },
      { setEnabled: async () => undefined },
    ),
  };
  return createApp(dependencies);
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

type OpenApiSchema = {
  readonly enum?: readonly unknown[];
  readonly type?: string;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly format?: string;
};
type OpenApiParameter = {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: OpenApiSchema;
};

async function readOpenApiDocument(): Promise<{
  readonly paths: Record<
    string,
    Record<string, { readonly parameters?: readonly OpenApiParameter[] }>
  >;
  readonly components: {
    readonly parameters?: Record<string, OpenApiParameter>;
  };
}> {
  return JSON.parse(
    await readFile(
      new URL("../contracts/openapi/public.openapi.json", import.meta.url),
      "utf8",
    ),
  );
}

// Every value the document announces must be one the runtime actually accepts,
// so an announced parameter or enum member can never answer VALIDATION_ERROR.
function announcedValues(schema: OpenApiSchema | undefined): readonly string[] {
  if (schema?.enum) return schema.enum.map((value) => String(value));
  if (schema?.type === "integer")
    return [String(schema.default ?? schema.minimum ?? 1)];
  if (schema?.format === "date-time") return ["2026-01-01T12:00:00.000Z"];
  return ["sample"];
}

function samplePath(expressPath: string): string {
  return expressPath.replace(/:\w+/g, "sample");
}

describe("versioned contracts", () => {
  it("publishes closed traceable Event and Evidence resources", () => {
    const event = {
      id: "evt_a56cfhze7zv2cj2fn5hwc35fm7",
      datasetVersion: `dsv_${"a".repeat(64)}`,
      category: "signal_observation",
      source: {
        system: "argus",
        dataset: "signal_bucket",
        recordId: '[["id","signal-1"]]',
        canonicalLocator: "canonical://dsv/signal_bucket/record",
      },
      occurredAt: "2026-09-21T12:00:00.000Z",
      window: null,
      dimensions: { source: "prometheus", entity: "edge-a" },
      measures: { value: 4.25 },
      correlation: {
        status: "linked",
        incidentIds: ["inc_known"],
        links: [
          {
            correlationId: "cor_known",
            incidentId: "inc_known",
            ruleVersion: "argus-explicit-v1",
            timeDistanceSeconds: -60,
            matchedFields: [
              {
                eventField: "source",
                incidentField: "business_service",
                value: "prometheus",
              },
            ],
          },
        ],
      },
      quality: {
        status: "measured",
        flags: [],
        observedThrough: "2026-09-21T12:05:00.000Z",
      },
      raw: {
        available: false,
        reason: "not_materialized_in_event_projection",
      },
    } as const;
    const evidence = {
      id: "evd_known",
      eventId: event.id,
      incidentId: "inc_known",
      type: "argus_event_correlation",
      relation: "context",
      hypothesisIds: [],
      strength: "moderate",
      observedAt: event.occurredAt,
      source: {
        type: "argus_event",
        name: "signal_bucket",
        dataset: "signal_bucket",
        recordId: event.source.recordId,
      },
      correlation: event.correlation.links[0],
      quality: {
        status: "verified",
        coverageRatio: 1,
        flags: [],
      },
    } as const;

    expect(eventDtoSchema.parse(event)).toEqual(event);
    expect(evidenceDtoSchema.parse(evidence)).toEqual(evidence);
    expect(
      eventsDataRuntimeSchema.parse({
        incident: null,
        capabilities: {
          filtering: {
            status: "available",
            supportedDimensions: ["category", "sourceDataset", "correlation"],
            supportedFilterSets: [["category", "sourceDataset", "correlation"]],
          },
        },
        categoryStats: [{ category: "signal_observation", count: 1 }],
        volumeSeries: null,
        items: [event],
        facets: {
          categories: ["signal_observation"],
          sourceDatasets: ["signal_bucket"],
          correlationStatuses: ["linked", "unlinked"],
        },
        page: { limit: 50, hasMore: false, nextCursor: null },
      }),
    ).toBeTruthy();
    expect(() => eventDtoSchema.parse({ ...event, pk: "physical" })).toThrow();
    expect(() =>
      evidenceDtoSchema.parse({ ...evidence, correlation: undefined }),
    ).toThrow();
  });

  it("accepts the documented global Event filters and binds safe defaults", () => {
    expect(
      eventsQuerySchema.parse({
        sourceDataset: "signal_bucket",
        correlation: "unlinked",
        limit: "100",
      }),
    ).toMatchObject({
      sourceDataset: "signal_bucket",
      correlation: "unlinked",
      limit: 100,
      sort: "recent",
      window: "30m",
    });
    expect(() => eventsQuerySchema.parse({ correlation: "maybe" })).toThrow();
    expect(() => eventsQuerySchema.parse({ limit: "101" })).toThrow();
    expect(() =>
      eventsQuerySchema.parse({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      eventsQuerySchema.parse({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-02T00:00:00.000Z",
      }),
    ).toThrow();
    expect(
      eventsQuerySchema.parse({
        from: "2026-01-01T08:40:00.000-03:00",
        to: "2026-01-01T11:40:00.000Z",
      }),
    ).toMatchObject({ from: "2026-01-01T08:40:00.000-03:00" });
    expect(eventsQuerySchema.parse({ window: "all" }).window).toBe("all");
    expect(incidentsQuerySchema.parse({ window: "all" }).window).toBe("all");
  });

  it("documents the same Event filters and pagination for Incident scope", async () => {
    const document = await readOpenApiDocument();
    const global = document.paths["/api/v1/events"]?.get?.parameters ?? [];
    const scoped =
      document.paths["/api/v1/incidents/{incidentId}/events"]?.get
        ?.parameters ?? [];

    expect(scoped.slice(1)).toEqual(global);
  });

  it("accepts only a strict boolean ARGUS live sync update", () => {
    expect(argusLiveSyncUpdateSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(() =>
      argusLiveSyncUpdateSchema.parse({ enabled: "true" }),
    ).toThrow();
    expect(() =>
      argusLiveSyncUpdateSchema.parse({ enabled: true, actor: "usr_1" }),
    ).toThrow();
  });

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

  it("bounds and normalizes untrusted browser telemetry", () => {
    const parsed = rumTelemetrySchema.parse({
      schemaVersion: 1,
      name: "frontend_web_vitals_lcp_seconds",
      value: 2.5,
      unit: "seconds",
      path: "/unbounded-cardinality-value",
      occurredAt: "2026-09-10T12:00:00.000Z",
    });
    expect(parsed.path).toBe("/other");
    expect(() =>
      rumTelemetrySchema.parse({
        schemaVersion: 1,
        name: "frontend_client_errors_total",
        value: 1000,
        unit: "count",
        path: "/",
        occurredAt: "2026-09-10T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("correlates structured logs with the active trace and redacts secrets", () => {
    let output = "";
    const originalWrite = process.stdout.write;
    const activeSpan = vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.SAMPLED,
      }),
    } as never);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      createLogger("api").info("correlated", {
        request_id: "req_test",
        token: "must-not-leak",
        service_name: "forged-service",
        trace_id: "forged-trace",
        level: "error",
        message: "forged-message",
      });
    } finally {
      process.stdout.write = originalWrite;
      activeSpan.mockRestore();
    }
    expect(JSON.parse(output)).toMatchObject({
      service_name: "api",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      request_id: "req_test",
      token: "[REDACTED]",
      level: "info",
      message: "correlated",
    });
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
        fileName: "argus_dump.sql.gz",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-09-17",
      }),
    ).toEqual({
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
    });
    expect(() =>
      startImportBodySchema.parse({
        fileName: "argus_dump.sql.gz",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-09-17",
        sha256: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      startImportBodySchema.parse({
        fileName: "other.sql.gz",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-09-17",
      }),
    ).toThrow();
    expect(() => startImportBodySchema.parse({ sha256: "invalid" })).toThrow();
    expect(
      completeImportBodySchema.parse({
        parts: [
          {
            partNumber: 1,
            etag: "etag-1",
            checksumSha256: "A".repeat(43) + "=",
          },
          {
            partNumber: 1,
            etag: "etag-2",
            checksumSha256: "A".repeat(43) + "=",
          },
        ],
      }).parts,
    ).toHaveLength(2);
  });

  it("uses one semantic civil-date contract for start requests and snapshots", async () => {
    const cases = await civilDateCases();
    const snapshot = {
      importId: "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      requestedBy: "usr_1",
      author: { id: "usr_1", name: null, email: null },
      canManageUpload: false,
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1,
      snapshotExtractedOn: "2024-02-29",
      createdAt: "2026-09-17T12:00:00.000Z",
      updatedAt: "2026-09-17T12:00:00.000Z",
      state: "READY",
      version: 2,
      progress: { kind: "none" },
      candidateVersion: null,
      error: null,
    };

    for (const value of cases.valid) {
      expect(civilDateSchema.safeParse(value).success, value).toBe(true);
      expect(
        startImportBodySchema.safeParse({
          fileName: "argus_dump.sql.gz",
          sizeBytes: 1,
          snapshotExtractedOn: value,
        }).success,
        value,
      ).toBe(true);
      expect(
        importSnapshotSchema.safeParse({
          ...snapshot,
          snapshotExtractedOn: value,
        }).success,
        value,
      ).toBe(true);
    }

    for (const value of cases.invalid) {
      expect(civilDateSchema.safeParse(value).success, value).toBe(false);
      expect(
        startImportBodySchema.safeParse({
          fileName: "argus_dump.sql.gz",
          sizeBytes: 1,
          snapshotExtractedOn: value,
        }).success,
        value,
      ).toBe(false);
      expect(
        importSnapshotSchema.safeParse({
          ...snapshot,
          snapshotExtractedOn: value,
        }).success,
        value,
      ).toBe(false);
    }
  });

  it("freezes strict import requests and public responses", () => {
    expect(importsQuerySchema.parse({ limit: "10" })).toEqual({ limit: 10 });
    expect(() =>
      importsQuerySchema.parse({ limit: "10", bucket: "private" }),
    ).toThrow();
    expect(restartImportBodySchema.parse({})).toEqual({});
    expect(() =>
      restartImportBodySchema.parse({ uploadId: "private" }),
    ).toThrow();
    expect(
      signImportPartsBodySchema.parse({
        parts: [{ partNumber: 1, checksumSha256: "A".repeat(43) + "=" }],
      }),
    ).toEqual({
      parts: [{ partNumber: 1, checksumSha256: "A".repeat(43) + "=" }],
    });
    expect(() =>
      signImportPartsBodySchema.parse({
        parts: [{ partNumber: 1, checksumSha256: "not-a-sha256" }],
      }),
    ).toThrow();
    expect(importIdSchema.parse("imp_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(() => importIdSchema.parse("imp_not-a-ulid")).toThrow();
    expect(() =>
      importIdSchema.parse("imp_Z1ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ).toThrow();
    expect(
      startImportBodySchema.parse({
        fileName: " argus_archive.ZIP ",
        sizeBytes: 6 * 1024 ** 3,
        snapshotExtractedOn: "2026-09-17",
      }),
    ).toEqual({
      fileName: "argus_archive.ZIP",
      sizeBytes: 6 * 1024 ** 3,
      snapshotExtractedOn: "2026-09-17",
    });
    expect(() =>
      startImportBodySchema.parse({
        fileName: "argus_dump.sql.gz",
        sizeBytes: 6 * 1024 ** 3,
        snapshotExtractedOn: "2026-09-17",
      }),
    ).toThrow();

    const snapshot = {
      importId: "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      requestedBy: "usr_1",
      author: { id: "usr_1", name: "Ana", email: "ana@example.test" },
      canManageUpload: true,
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
      createdAt: "2026-09-17T12:00:00.000Z",
      updatedAt: "2026-09-17T12:00:00.000Z",
      state: "UPLOADING",
      version: 1,
      progress: { kind: "bytes", completedBytes: 512, totalBytes: 1024 },
      candidateVersion: null,
      error: null,
    };
    expect(importSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      importSnapshotSchema.parse({ ...snapshot, fileName: "other.sql.gz" }),
    ).toThrow();
    expect(
      importSnapshotSchema.parse({ ...snapshot, fileName: " archive.ZIP " })
        .fileName,
    ).toBe("archive.ZIP");
    expect(importPageSchema.parse({ items: [snapshot], cursor: null })).toEqual(
      {
        items: [snapshot],
        cursor: null,
      },
    );
    expect(() =>
      importSnapshotSchema.parse({ ...snapshot, uploadId: "private" }),
    ).toThrow();
    expect(errorCodeSchema.options).toEqual(
      expect.arrayContaining([
        "IMPORT_IN_PROGRESS",
        "IMPORT_NOT_OWNED",
        "IMPORT_STATE_CONFLICT",
        "IMPORT_NOT_FOUND",
        "UPLOAD_EXPIRED",
        "UPLOAD_PREPARATION_FAILED",
        "WORKER_STOPPED",
        "MYSQL_CONNECTION_LOST",
        "MYSQL_QUERY_TIMEOUT",
        "QUERY_PLAN_INVALID",
        "ARCHIVE_PUBLICATION_FAILED",
        "DYNAMODB_THROTTLED",
        "DISK_PRESSURE",
        "CHECKSUM_MISMATCH",
        "SOURCE_SCHEMA_INVALID",
        "DATA_RECONCILIATION_FAILED",
      ]),
    );
    expect(
      importSafeErrorSchema.parse({
        code: "MYSQL_CONNECTION_LOST",
        message: "A conexão com o MySQL foi perdida.",
        requestId: "req_1",
        stage: "INGESTING",
        retryable: true,
        attempt: 4,
        maxAttempts: 4,
      }),
    ).toEqual({
      code: "MYSQL_CONNECTION_LOST",
      message: "A conexão com o MySQL foi perdida.",
      requestId: "req_1",
      stage: "INGESTING",
      retryable: true,
      attempt: 4,
      maxAttempts: 4,
    });
    expect(
      importInProgressErrorSchema.parse({
        error: {
          code: "IMPORT_IN_PROGRESS",
          message: "Há uma importação em andamento.",
          requestId: "req_1",
          details: { importId: "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        },
      }),
    ).toMatchObject({ error: { code: "IMPORT_IN_PROGRESS" } });
    expect(() =>
      importInProgressErrorSchema.parse({
        error: {
          code: "IMPORT_IN_PROGRESS",
          message: "Há uma importação em andamento.",
          requestId: "req_1",
          details: {},
        },
      }),
    ).toThrow();
  });

  it("accepts detailed stage progress without requiring it from legacy imports", () => {
    const detailed = {
      kind: "stage" as const,
      stage: "INGESTING",
      stageStartedAt: "2026-09-17T12:00:00.000Z",
      heartbeatAt: "2026-09-17T12:01:00.000Z",
      recordsRead: 125,
      recordsWritten: 120,
      recordsRejected: 5,
      recordsTotal: 1000,
      currentDataset: "signal_bucket",
      datasetsCompleted: 2,
      datasetsTotal: 23,
    };
    const base = {
      importId: "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      requestedBy: "usr_1",
      author: { id: "usr_1", name: "Ana", email: "ana@example.test" },
      canManageUpload: true,
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
      createdAt: "2026-09-17T12:00:00.000Z",
      updatedAt: "2026-09-17T12:01:00.000Z",
      state: "PROCESSING" as const,
      version: 3,
      candidateVersion: null,
      error: null,
    };

    expect(
      importSnapshotSchema.parse({ ...base, progress: detailed }).progress,
    ).toEqual(detailed);
    expect(
      importSnapshotSchema.parse({
        ...base,
        progress: {
          kind: "stage",
          stage: "INGESTING",
          recordsRead: 0,
          recordsWritten: 0,
          recordsRejected: 0,
        },
      }).progress,
    ).toMatchObject({ stage: "INGESTING" });

    const canonical = {
      kind: "stage" as const,
      stage: "ARCHIVING",
      recordsRead: 10,
      recordsWritten: 10,
      recordsRejected: 0,
      substage: "UPLOADING",
      currentPartition: "snapshot_date=2026-09-17",
      unitsCompleted: 2,
      unitsTotal: 3,
      unitLabel: "partições",
    };
    expect(
      importSnapshotSchema.parse({ ...base, progress: canonical }).progress,
    ).toEqual(canonical);
    expect(() =>
      importSnapshotSchema.parse({
        ...base,
        progress: { ...canonical, unitsTotal: 1 },
      }),
    ).toThrow();
    expect(() =>
      importSnapshotSchema.parse({
        ...base,
        progress: { ...canonical, unitLabel: undefined },
      }),
    ).toThrow();
  });

  it("keeps runtime and OpenAPI run stage enums in parity", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as {
      components: {
        schemas: Record<
          string,
          { oneOf: readonly { properties?: { stage?: { enum?: string[] } } }[] }
        >;
      };
    };
    const announced =
      document.components.schemas.ImportProgress.oneOf[1]?.properties?.stage
        ?.enum;

    expect(announced).toEqual(importRunStageSchema.options);
    expect(importRunStageSchema.options).toEqual(
      expect.arrayContaining([
        "INGESTING",
        "EXTRACTING",
        "ARCHIVING",
        "MATERIALIZING_HOT",
        "FINALIZING_CANDIDATE",
      ]),
    );
  });

  it("keeps accepted response filenames and multipart geometry aligned in OpenAPI", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as {
      paths: Record<string, Record<string, { parameters?: unknown[] }>>;
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, unknown>;
          }
        >;
      };
    };
    const snapshotFileName = document.components.schemas.ImportSnapshot
      ?.properties?.fileName as {
      oneOf?: readonly { const?: string; pattern?: string }[];
    };
    expect(snapshotFileName.oneOf).toEqual([
      { const: "argus_dump.sql.gz" },
      expect.objectContaining({ pattern: expect.stringContaining("[zZ]") }),
    ]);
    expect(
      importSnapshotSchema.safeParse({
        importId: "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedBy: "usr_1",
        author: { id: "usr_1", name: null, email: null },
        canManageUpload: false,
        fileName: "archive.zip",
        sizeBytes: 1,
        snapshotExtractedOn: "2026-09-17",
        createdAt: "2026-09-17T12:00:00.000Z",
        updatedAt: "2026-09-17T12:00:00.000Z",
        state: "READY",
        version: 2,
        progress: { kind: "none" },
        candidateVersion: null,
        error: null,
      }).success,
    ).toBe(true);
    const signParts = document.components.schemas.SignImportPartsRequest
      ?.properties?.parts as { description?: string };
    const completeParts = document.components.schemas.CompleteImportRequest
      ?.properties?.parts as { description?: string };
    expect(signParts.description).toContain("16 MiB");
    expect(completeParts.description).toContain("16 MiB");

    const signOperation =
      document.paths["/api/v1/imports/{importId}/parts"]?.post;
    expect(signOperation?.parameters).toEqual([
      { $ref: "#/components/parameters/ImportId" },
    ]);
  });

  it("keeps actionable import failures in parity with OpenAPI", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as {
      components: {
        schemas: {
          ImportSafeError: {
            required: readonly string[];
            properties: {
              code: { enum: readonly string[] };
            };
          };
        };
      };
    };
    const schema = document.components.schemas.ImportSafeError;

    expect(schema.properties.code.enum).toEqual(errorCodeSchema.options);
    expect(schema.required).toEqual([
      "code",
      "message",
      "requestId",
      "stage",
      "retryable",
      "attempt",
      "maxAttempts",
    ]);
  });

  it("keeps OpenAPI aligned with import format limits and conflicts", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as {
      components: {
        parameters: { ImportId: { schema: { pattern?: string } } };
        responses: {
          ImportInProgress: {
            content: {
              "application/json": {
                schema: { $ref?: string };
              };
            };
          };
        };
        schemas: {
          CivilDate: {
            type?: string;
            format?: string;
            oneOf?: readonly { pattern?: string }[];
          };
          ImportSnapshot: {
            properties?: {
              snapshotExtractedOn?: { $ref?: string };
            };
          };
          StartImportRequest: {
            oneOf?: readonly {
              properties?: {
                fileName?: { const?: string; pattern?: string };
                sizeBytes?: { maximum?: number };
                snapshotExtractedOn?: { $ref?: string };
              };
            }[];
            additionalProperties?: boolean;
          };
          CompleteImportRequest: {
            properties?: { parts?: Record<string, unknown> };
          };
          ImportInProgressError: {
            additionalProperties?: boolean;
            properties?: {
              error?: {
                additionalProperties?: boolean;
                properties?: {
                  code?: { const?: string };
                  details?: {
                    additionalProperties?: boolean;
                    required?: readonly string[];
                    properties?: { importId?: { pattern?: string } };
                  };
                };
              };
            };
          };
        };
      };
      paths: {
        "/api/v1/imports": {
          post: { responses: Record<string, { $ref?: string }> };
        };
      };
    };
    const variants = document.components.schemas.StartImportRequest.oneOf;
    const civilDateOpenApi = document.components.schemas.CivilDate;
    expect(civilDateOpenApi).toEqual({
      type: "string",
      format: "date",
      oneOf: [
        {
          pattern:
            "^(?:000[1-9]|00[1-9]\\d|0[1-9]\\d{2}|[1-9]\\d{3})-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8]))$",
        },
        {
          pattern:
            "^(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26]))|(?:(?:0[48]|[2468][048]|[13579][26])00))-02-29$",
        },
      ],
    });
    expect(civilDateOpenApi.oneOf?.map(({ pattern }) => pattern)).toEqual(
      civilDatePatternSources,
    );
    const openApiPatterns = civilDateOpenApi.oneOf!.map(
      ({ pattern }) => new RegExp(pattern!),
    );
    const acceptedByOpenApi = (value: string) =>
      openApiPatterns.filter((pattern) => pattern.test(value)).length === 1;
    const broadCases = [
      "0000-01-01",
      "0001-01-01",
      "9999-12-31",
      "1900-02-29",
      "2000-02-29",
      "2024-02-29",
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      ...[1, 4, 100, 400, 1900, 1996, 2000, 2024, 2100, 2400, 9999].flatMap(
        (year) =>
          Array.from({ length: 14 }, (_, month) =>
            Array.from(
              { length: 33 },
              (_, day) =>
                `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            ),
          ).flat(),
      ),
      ...Array.from(
        { length: 9999 },
        (_, offset) => `${String(offset + 1).padStart(4, "0")}-02-29`,
      ),
    ];
    for (const value of broadCases) {
      expect(acceptedByOpenApi(value), value).toBe(
        civilDateSchema.safeParse(value).success,
      );
    }
    expect(
      document.components.schemas.ImportSnapshot.properties
        ?.snapshotExtractedOn,
    ).toEqual({ $ref: "#/components/schemas/CivilDate" });
    expect(
      variants?.map((variant) => variant.properties?.snapshotExtractedOn),
    ).toEqual([
      { $ref: "#/components/schemas/CivilDate" },
      { $ref: "#/components/schemas/CivilDate" },
    ]);
    expect(variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            fileName: expect.objectContaining({
              const: "argus_dump.sql.gz",
            }),
            sizeBytes: expect.objectContaining({
              maximum: 5 * 1024 ** 3,
            }),
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            fileName: expect.objectContaining({
              pattern: expect.stringContaining("[zZ][iI][pP]"),
            }),
            sizeBytes: expect.objectContaining({
              maximum: 10 * 1024 ** 3,
            }),
          }),
        }),
      ]),
    );
    expect(document.components.parameters.ImportId.schema.pattern).toBe(
      "^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    );
    expect(
      document.components.schemas.CompleteImportRequest.properties?.parts,
    ).not.toHaveProperty("x-uniqueBy");
    const zipPattern = variants
      ?.map((variant) => variant.properties?.fileName?.pattern)
      .find((pattern): pattern is string => Boolean(pattern));
    expect(zipPattern).toBeDefined();
    const openApiZip = new RegExp(zipPattern as string);
    expect(openApiZip.test(" argus_archive.ZIP ")).toBe(true);
    for (const invalidFileName of [" .zip", "   .ZIP", "folder/dump.zip"])
      expect(openApiZip.test(invalidFileName)).toBe(false);
    for (const invalidFileName of [" .zip", "   .ZIP", "folder/dump.zip"])
      expect(() =>
        startImportBodySchema.parse({
          fileName: invalidFileName,
          sizeBytes: 1024,
          snapshotExtractedOn: "2026-09-17",
        }),
      ).toThrow();
    expect(document.paths["/api/v1/imports"].post.responses["409"]).toEqual({
      $ref: "#/components/responses/ImportInProgress",
    });
    expect(
      document.components.responses.ImportInProgress.content["application/json"]
        .schema,
    ).toEqual({ $ref: "#/components/schemas/ImportInProgressError" });
    const conflict = document.components.schemas.ImportInProgressError;
    expect(conflict).toMatchObject({
      additionalProperties: false,
      properties: {
        error: {
          additionalProperties: false,
          properties: {
            code: { const: "IMPORT_IN_PROGRESS" },
            details: {
              additionalProperties: false,
              required: ["importId"],
              properties: {
                importId: { pattern: "^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
              },
            },
          },
        },
      },
    });
  });

  it("enforces the limit boundaries (1-100, default 20) on incidentsQuerySchema", () => {
    expect(incidentsQuerySchema.parse({}).limit).toBe(20);
    expect(incidentsQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(incidentsQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(() => incidentsQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => incidentsQuerySchema.parse({ limit: "101" })).toThrow();
    expect(() => incidentsQuerySchema.parse({ limit: "abc" })).toThrow();
  });

  it("builds valid success and error envelopes with request ids", () => {
    const datasetVersion = `dsv_${"a".repeat(64)}`;
    const success = successEnvelope(
      {
        data: { value: 1 },
        datasetVersion,
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
    expect(responseMetaSchema.parse(success.meta)).toMatchObject({
      requestId: "req_test",
      datasetVersion,
    });
    expect(
      errorEnvelope(
        new ServiceError(503, "DATA_UNAVAILABLE", "missing"),
        "req_error",
      ).error,
    ).toMatchObject({ code: "DATA_UNAVAILABLE", requestId: "req_error" });
  });

  it("requires a nullable canonical dataset version in every success envelope", () => {
    const datasetless = successEnvelope(
      {
        data: { authenticated: true },
        datasetVersion: null,
        quality: {
          window: null,
          partial: false,
          refreshAfterSeconds: null,
          freshness: [],
          warnings: [],
        },
      },
      "req_datasetless",
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(
      responseMetaSchema.parse(datasetless.meta).datasetVersion,
    ).toBeNull();
    expect(() =>
      responseMetaSchema.parse({
        ...datasetless.meta,
        datasetVersion: "dsv_not-a-sha256",
      }),
    ).toThrow();
    const { datasetVersion: _omitted, ...missingDatasetVersion } =
      datasetless.meta as typeof datasetless.meta & {
        datasetVersion?: string | null;
      };
    expect(() => responseMetaSchema.parse(missingDatasetVersion)).toThrow();
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

  it("keeps the import manifest and OpenAPI document in parity", async () => {
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
  });

  it("publishes OpenAPI 3.1 for every public gateway operation", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: {
        schemas: Record<
          string,
          {
            required?: readonly string[];
            properties?: Record<string, unknown>;
          }
        >;
      };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.components.schemas.Meta?.required).toContain(
      "datasetVersion",
    );
    expect(
      document.components.schemas.Meta?.properties?.datasetVersion,
    ).toEqual({
      type: ["string", "null"],
      pattern: "^dsv_[0-9a-f]{64}$",
    });
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
      "/api/v1/imports/{importId}/parts",
      "/api/v1/imports/{importId}/restart",
      "/api/v1/imports/{importId}/complete",
      "/api/v1/imports/{importId}/activate",
      "/api/v1/imports/{importId}",
      "/api/v1/integrations/argus",
      "/health",
      "/metrics",
      "/api/v1/telemetry/rum",
    ])
      expect(document.paths).toHaveProperty(path);
    const imports = document.paths["/api/v1/imports"] as {
      get?: { responses?: Record<string, unknown> };
      post?: { responses?: Record<string, unknown> };
    };
    expect(imports.get?.responses).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "503": expect.anything(),
      }),
    );
    expect(imports.post?.responses).toEqual(
      expect.objectContaining({
        "201": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "409": expect.anything(),
      }),
    );
    for (const [path, method, expected] of [
      [
        "/api/v1/imports/{importId}",
        "get",
        ["200", "401", "403", "404", "503"],
      ],
      ["/api/v1/imports/{importId}/parts", "get", ["200", "401", "403", "404"]],
      [
        "/api/v1/imports/{importId}/parts",
        "post",
        ["200", "400", "401", "403", "404", "409"],
      ],
      [
        "/api/v1/imports/{importId}/restart",
        "post",
        ["202", "400", "401", "403", "404", "409"],
      ],
      [
        "/api/v1/imports/{importId}/complete",
        "post",
        ["202", "400", "401", "403", "404", "409"],
      ],
      [
        "/api/v1/imports/{importId}/activate",
        "post",
        ["200", "400", "401", "404", "409", "503"],
      ],
    ] as const) {
      const operation = (
        document.paths[path] as Record<
          string,
          { responses?: Record<string, unknown> }
        >
      )[method];
      for (const status of expected)
        expect(
          operation?.responses,
          `${method.toUpperCase()} ${path}`,
        ).toHaveProperty(status);
    }
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
      patch?: {
        security?: readonly Record<string, readonly unknown[]>[];
        responses?: Record<string, unknown>;
      };
    };
    expect(session.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(review.patch?.security).toEqual([{ sessionCookie: [] }]);
    const argus = document.paths["/api/v1/integrations/argus"] as {
      get?: {
        security?: readonly Record<string, readonly unknown[]>[];
        responses?: Record<string, unknown>;
      };
      patch?: {
        security?: readonly Record<string, readonly unknown[]>[];
        requestBody?: { content?: { [key: string]: { schema?: unknown } } };
        responses?: Record<string, unknown>;
      };
    };
    expect(argus.get).toMatchObject({
      security: [{ sessionCookie: [] }],
      responses: {
        "200": expect.anything(),
        "401": expect.anything(),
        "503": expect.anything(),
      },
    });
    expect(argus.patch).toMatchObject({
      security: [{ sessionCookie: [] }],
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ArgusLiveSyncUpdate" },
          },
        },
      },
      responses: {
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "503": expect.anything(),
      },
    });
    expect(document.components.schemas.ArgusLiveSyncUpdate).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    });
    expect(review.patch?.responses).toHaveProperty("503");

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
  it("accepts every query parameter and enum value the OpenAPI document announces", async () => {
    const document = await readOpenApiDocument();
    const componentParameters = document.components.parameters ?? {};
    const expressByOperation = new Map(
      Object.values(PUBLIC_ROUTES).map((route) => [
        `${route.method.toUpperCase()} ${route.openapi}`,
        route.express,
      ]),
    );

    const listener = await listen(buildPublicApp());
    try {
      for (const [path, operations] of Object.entries(document.paths)) {
        const operation = operations.get;
        if (!operation) continue;
        const expressPath = expressByOperation.get(`GET ${path}`);
        expect(expressPath, `GET ${path}`).toBeDefined();
        const queryParameters = (operation.parameters ?? [])
          .map((declared) =>
            declared.$ref
              ? componentParameters[declared.$ref.split("/").at(-1) ?? ""]
              : declared,
          )
          .filter(
            (parameter): parameter is OpenApiParameter =>
              parameter?.in === "query" && Boolean(parameter.name),
          );
        // Co-required parameters must travel together, so every probe starts
        // from the minimal query the document itself declares as mandatory.
        const required = queryParameters
          .filter((parameter) => parameter.required === true)
          .map(
            (parameter) =>
              [
                parameter.name as string,
                announcedValues(parameter.schema)[0] as string,
              ] as const,
          );
        for (const parameter of queryParameters) {
          for (const value of announcedValues(parameter.schema)) {
            const query = new URLSearchParams(
              required.map(([key, base]) => [key, base]),
            );
            query.set(parameter.name as string, value);
            if (parameter.name === "from" && !query.has("to"))
              query.set("to", "2026-01-01T13:00:00.000Z");
            if (parameter.name === "to" && !query.has("from"))
              query.set("from", "2026-01-01T11:00:00.000Z");
            const response = await fetch(
              `${listener.url}${samplePath(expressPath as string)}?${query}`,
            );
            const label = `GET ${path}?${parameter.name}=${value}`;
            expect(response.status, label).not.toBe(400);
            expect(await response.json(), label).not.toMatchObject({
              error: { code: "VALIDATION_ERROR" },
            });
          }
        }
      }
    } finally {
      await listener.close();
    }
  });
});

import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

export const datasetVersionSchema = z.string().regex(/^dsv_[0-9a-f]{64}$/);
export type DatasetVersion = z.infer<typeof datasetVersionSchema>;

export const argusLiveSyncUpdateSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type ArgusLiveSyncUpdate = z.infer<typeof argusLiveSyncUpdateSchema>;

export const requestId = (): string =>
  `req_${randomUUID().replaceAll("-", "")}`;

export const rumMetricNames = [
  "frontend_web_vitals_fcp_seconds",
  "frontend_web_vitals_lcp_seconds",
  "frontend_web_vitals_inp_ms",
  "frontend_web_vitals_cls",
  "frontend_client_errors_total",
  "frontend_api_fetch_errors_total",
  "operator_clicks_to_root_cause",
] as const;

const rumPaths = new Set([
  "/",
  "/login",
  "/visao-geral",
  "/incidentes",
  "/evidencias",
  "/eventos",
  "/monitoramento",
  "/configuracoes",
  "/criar-conta",
  "/recuperar-senha",
  "/design-system",
]);
const rumMetricUnits = {
  frontend_web_vitals_fcp_seconds: "seconds",
  frontend_web_vitals_lcp_seconds: "seconds",
  frontend_web_vitals_inp_ms: "milliseconds",
  frontend_web_vitals_cls: "score",
  frontend_client_errors_total: "count",
  frontend_api_fetch_errors_total: "count",
  operator_clicks_to_root_cause: "count",
} as const;
const rumMetricMaximums = {
  frontend_web_vitals_fcp_seconds: 60,
  frontend_web_vitals_lcp_seconds: 60,
  frontend_web_vitals_inp_ms: 60_000,
  frontend_web_vitals_cls: 10,
  frontend_client_errors_total: 1,
  frontend_api_fetch_errors_total: 1,
  operator_clicks_to_root_cause: 100,
} as const;

export const rumTelemetrySchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.enum(rumMetricNames),
    value: z.number().finite().nonnegative(),
    unit: z.enum(["seconds", "milliseconds", "score", "count"]),
    metricId: z.string().min(1).max(128).optional(),
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\/[A-Za-z0-9/_-]*$/)
      .transform((path) => (rumPaths.has(path) ? path : "/other")),
    navigationType: z.string().min(1).max(64).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.unit !== rumMetricUnits[value.name])
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: `Expected ${rumMetricUnits[value.name]} for ${value.name}`,
      });
    if (value.value > rumMetricMaximums[value.name])
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `Value exceeds the limit for ${value.name}`,
      });
  });
export type RumTelemetry = z.infer<typeof rumTelemetrySchema>;

export const warningSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();
export type Warning = z.infer<typeof warningSchema>;

export const freshnessSchema = z
  .object({
    source: z.string().min(1),
    observedThrough: z.iso.datetime({ offset: true }).nullable(),
    lagSeconds: z.number().nonnegative().nullable(),
    state: z.enum(["fresh", "delayed", "partial", "unavailable"]),
  })
  .strict();
export type Freshness = z.infer<typeof freshnessSchema>;

export const resolvedWindowSchema = z
  .object({
    preset: z.string().nullable(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ResolvedWindow = z.infer<typeof resolvedWindowSchema>;

export const responseMetaSchema = z
  .object({
    requestId: z.string().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
    datasetVersion: datasetVersionSchema.nullable(),
    generatedAt: z.iso.datetime({ offset: true }),
    window: resolvedWindowSchema.nullable(),
    partial: z.boolean(),
    refreshAfterSeconds: z.number().int().positive().nullable(),
    freshness: z.array(freshnessSchema),
    warnings: z.array(warningSchema),
  })
  .strict();
export type ResponseMeta = z.infer<typeof responseMetaSchema>;

export interface QualityContext {
  readonly window: ResolvedWindow | null;
  readonly partial: boolean;
  readonly refreshAfterSeconds: number | null;
  readonly freshness: readonly Freshness[];
  readonly warnings: readonly Warning[];
}

export interface InternalResponse<T> {
  readonly data: T;
  readonly datasetVersion: DatasetVersion | null;
  readonly quality: QualityContext;
}

export const internalResponseSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      data,
      datasetVersion: datasetVersionSchema.nullable(),
      quality: z
        .object({
          window: resolvedWindowSchema.nullable(),
          partial: z.boolean(),
          refreshAfterSeconds: z.number().int().positive().nullable(),
          freshness: z.array(freshnessSchema),
          warnings: z.array(warningSchema),
        })
        .strict(),
    })
    .strict();

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export function successEnvelope<T>(
  result: InternalResponse<T>,
  currentRequestId: string,
  now: Date = new Date(),
): SuccessEnvelope<T> {
  return {
    data: result.data,
    meta: {
      requestId: currentRequestId,
      schemaVersion: SCHEMA_VERSION,
      datasetVersion: result.datasetVersion,
      generatedAt: now.toISOString(),
      window: result.quality.window,
      partial: result.quality.partial,
      refreshAfterSeconds: result.quality.refreshAfterSeconds,
      freshness: [...result.quality.freshness],
      warnings: [...result.quality.warnings],
    },
  };
}

export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "CONFLICT",
  "REVIEW_VERSION_CONFLICT",
  "DIAGNOSIS_NOT_READY",
  "HYPOTHESIS_SUPERSEDED",
  "UNSUPPORTED_FILTER_COMBINATION",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "DATA_UNAVAILABLE",
  "FEATURE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
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
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export interface ErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly fields?: readonly ErrorField[];
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: readonly ErrorField[],
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function errorEnvelope(
  error: ServiceError,
  currentRequestId: string,
): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId: currentRequestId,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export const windowPresetSchema = z.enum(["15m", "30m", "1h", "6h", "24h"]);
const temporalWindowPresetSchema = z.union([
  windowPresetSchema,
  z.literal("all"),
]);

const temporalQueryShape = {
  window: temporalWindowPresetSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};

function validateTemporalQuery(value: {
  window?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): boolean {
  const custom = value.from !== undefined || value.to !== undefined;
  if (!custom) return true;
  if (
    value.from === undefined ||
    value.to === undefined ||
    value.window !== undefined
  )
    return false;
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  return from <= to && to - from <= 31 * 86_400_000;
}

export const overviewQuerySchema = z
  .object({
    window: windowPresetSchema.default("30m"),
    search: z.string().trim().max(100).optional(),
    deviceType: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    appVersion: z.string().trim().min(1).optional(),
    incidentLimit: z.coerce.number().int().min(1).max(10).default(5),
  })
  .strict();

export const incidentsQuerySchema = z
  .object({
    ...temporalQueryShape,
    search: z.string().trim().max(100).optional(),
    priority: z.string().optional(),
    status: z.string().optional(),
    deviceType: z.string().optional(),
    os: z.string().optional(),
    appVersion: z.string().optional(),
    region: z.string().optional(),
    state: z.string().optional(),
    isp: z.string().optional(),
    cdn: z.string().optional(),
    content: z.string().optional(),
    component: z.string().optional(),
    eventType: z.string().optional(),
    sort: z.enum(["priority", "impact", "recent"]).default("recent"),
    chartMetric: z
      .enum(["affected_devices", "affected_sessions"])
      .default("affected_devices"),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
  .refine(validateTemporalQuery, {
    message:
      "from e to devem formar uma janela crescente de até 31 dias e não podem ser combinados com window.",
  })
  .transform((value) => ({ ...value, window: value.window ?? "1h" }));
export type IncidentsQuery = z.output<typeof incidentsQuerySchema>;

export const eventsQuerySchema = z
  .object({
    ...temporalQueryShape,
    search: z.string().trim().max(100).optional(),
    category: z.string().optional(),
    sourceDataset: z.string().trim().min(1).optional(),
    correlation: z.enum(["all", "linked", "unlinked"]).default("all"),
    sort: z.enum(["recent", "oldest"]).default("recent"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
  .refine(validateTemporalQuery, {
    message:
      "from e to devem formar uma janela crescente de até 31 dias e não podem ser combinados com window.",
  })
  .transform((value) => ({ ...value, window: value.window ?? "30m" }));
export type EventsQuery = z.output<typeof eventsQuerySchema>;

export const monitoringQuerySchema = z
  .object({
    window: z.enum(["15m", "30m", "1h", "6h"]).default("15m"),
    source: z.string().optional(),
    worker: z.string().optional(),
    flowMetric: z
      .enum(["ingestion_rate", "processing_latency", "queue_depth"])
      .default("processing_latency"),
  })
  .strict();

export const reviewBodySchema = z
  .object({
    status: z.enum(["confirmed", "refuted", "inconclusive"]),
    note: z.string().trim().max(1000).nullable().optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export const importIdSchema = z
  .string()
  .regex(/^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export type ImportId = z.infer<typeof importIdSchema>;

export const importInProgressErrorSchema = z
  .object({
    error: z
      .object({
        code: z.literal("IMPORT_IN_PROGRESS"),
        message: z.string().trim().min(1),
        requestId: z.string().trim().min(1),
        details: z.object({ importId: importIdSchema }).strict(),
      })
      .strict(),
  })
  .strict();
export type ImportInProgressError = z.infer<typeof importInProgressErrorSchema>;

export const importStateSchema = z.enum([
  "PREPARING",
  "UPLOADING",
  "UPLOADED",
  "VALIDATING",
  "PROCESSING",
  "READY",
  "FAILED",
]);
export type ImportState = z.infer<typeof importStateSchema>;

const checksumSha256Schema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const multipartPartsDescription =
  "Cada parte não final possui exatamente 16 MiB; somente a parte final pode ser menor.";

export const civilDatePatternSources = [
  "^(?:000[1-9]|00[1-9]\\d|0[1-9]\\d{2}|[1-9]\\d{3})-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8]))$",
  "^(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26]))|(?:(?:0[48]|[2468][048]|[13579][26])00))-02-29$",
] as const;

const civilDatePatterns = civilDatePatternSources.map(
  (source) => new RegExp(source),
);

function isCivilDate(value: string): boolean {
  return civilDatePatterns.some((pattern) => pattern.test(value));
}

export const civilDateSchema = z
  .string()
  .refine(isCivilDate, "Data civil inválida.");
export type CivilDate = z.infer<typeof civilDateSchema>;

export const importFileNameSchema = z.union([
  z.literal("argus_dump.sql.gz"),
  z
    .string()
    .trim()
    .regex(/^[^/\\]{1,251}\.zip$/i),
]);

export const startImportBodySchema = z
  .object({
    fileName: importFileNameSchema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 ** 3),
    snapshotExtractedOn: civilDateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const limit =
      value.fileName === "argus_dump.sql.gz" ? 5 * 1024 ** 3 : 10 * 1024 ** 3;
    if (value.sizeBytes > limit)
      context.addIssue({
        code: "custom",
        path: ["sizeBytes"],
        message: "Arquivo excede o limite permitido.",
      });
  });
export type StartImportBody = z.infer<typeof startImportBodySchema>;

export const importsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();
export type ImportsQuery = z.output<typeof importsQuerySchema>;

export const signImportPartsBodySchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(10_000),
            checksumSha256: checksumSha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .describe(multipartPartsDescription),
  })
  .strict();
export type SignImportPartsBody = z.infer<typeof signImportPartsBodySchema>;

export const restartImportBodySchema = z.object({}).strict();
export type RestartImportBody = z.infer<typeof restartImportBodySchema>;

export const completeImportBodySchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(10_000),
            etag: z.string().trim().min(1).max(1024),
            checksumSha256: checksumSha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(10_000)
      .describe(multipartPartsDescription),
  })
  .strict();
export type CompleteImportBody = z.infer<typeof completeImportBodySchema>;

export const importAuthorSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256).nullable(),
    email: z.string().email().max(320).nullable(),
  })
  .strict();
export type ImportAuthor = z.infer<typeof importAuthorSchema>;

export const importRunStageSchema = z.enum([
  "STARTING",
  "RESTORING",
  "VALIDATING",
  "INGESTING",
  "EXTRACTING",
  "PROJECTING",
  "ARCHIVING",
  "ACTIVATING",
  "MATERIALIZING_HOT",
  "FINALIZING_CANDIDATE",
  "PUBLISHING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "SKIPPED_LOCKED",
  "SKIPPED_DISABLED",
]);
export type ImportRunStage = z.infer<typeof importRunStageSchema>;

export const importProgressSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bytes"),
      completedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.completedBytes <= value.totalBytes, {
      message: "completedBytes não pode exceder totalBytes.",
    }),
  z
    .object({
      kind: z.literal("stage"),
      stage: importRunStageSchema,
      substage: z.string().trim().min(1).max(128).optional(),
      stageStartedAt: z.iso.datetime({ offset: true, precision: 3 }).optional(),
      heartbeatAt: z.iso.datetime({ offset: true, precision: 3 }).optional(),
      recordsRead: z.number().int().nonnegative(),
      recordsWritten: z.number().int().nonnegative(),
      recordsRejected: z.number().int().nonnegative(),
      recordsTotal: z.number().int().nonnegative().nullable().optional(),
      currentDataset: z.string().trim().min(1).max(128).nullable().optional(),
      currentPartition: z.string().trim().min(1).max(128).optional(),
      datasetsCompleted: z.number().int().nonnegative().optional(),
      datasetsTotal: z.number().int().nonnegative().optional(),
      unitsCompleted: z.number().int().nonnegative().optional(),
      unitsTotal: z.number().int().nonnegative().optional(),
      unitLabel: z.string().trim().min(1).max(128).optional(),
    })
    .strict()
    .refine(
      (value) => {
        const details = [
          value.stageStartedAt,
          value.heartbeatAt,
          value.recordsTotal,
          value.currentDataset,
          value.datasetsCompleted,
          value.datasetsTotal,
        ];
        const present = details.filter((item) => item !== undefined).length;
        return present === 0 || present === details.length;
      },
      { message: "O detalhamento da etapa deve ser informado por completo." },
    )
    .refine(
      (value) =>
        value.stageStartedAt === undefined ||
        Date.parse(value.heartbeatAt!) >= Date.parse(value.stageStartedAt),
      { message: "heartbeatAt não pode preceder stageStartedAt." },
    )
    .refine(
      (value) =>
        value.datasetsCompleted === undefined ||
        value.datasetsCompleted <= value.datasetsTotal!,
      { message: "datasetsCompleted não pode exceder datasetsTotal." },
    )
    .refine(
      (value) =>
        value.recordsTotal === undefined ||
        value.recordsTotal === null ||
        value.recordsRead <= value.recordsTotal,
      { message: "recordsRead não pode exceder recordsTotal." },
    )
    .refine(
      (value) => {
        const units = [value.unitsCompleted, value.unitsTotal, value.unitLabel];
        const present = units.filter((item) => item !== undefined).length;
        return present === 0 || present === units.length;
      },
      { message: "O progresso por unidades deve ser informado por completo." },
    )
    .refine(
      (value) =>
        value.unitsCompleted === undefined ||
        value.unitsCompleted <= value.unitsTotal!,
      { message: "unitsCompleted não pode exceder unitsTotal." },
    ),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type ImportProgress = z.infer<typeof importProgressSchema>;

export const importSafeErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().trim().min(1).max(1000),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    stage: z.string().trim().min(1).max(128).nullable(),
    retryable: z.boolean(),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (value) => value.maxAttempts === null || value.attempt <= value.maxAttempts,
    { message: "attempt não pode exceder maxAttempts." },
  );
export type ImportSafeError = z.infer<typeof importSafeErrorSchema>;

export const importTimestampSchema = z.iso.datetime({
  offset: true,
  precision: 3,
});

export const importSnapshotSchema = z
  .object({
    importId: importIdSchema,
    requestedBy: z.string().trim().min(1).max(256),
    author: importAuthorSchema,
    canManageUpload: z.boolean(),
    fileName: importFileNameSchema,
    sizeBytes: z.number().int().positive(),
    snapshotExtractedOn: civilDateSchema,
    createdAt: importTimestampSchema,
    updatedAt: importTimestampSchema,
    state: importStateSchema,
    version: z.number().int().nonnegative(),
    progress: importProgressSchema,
    candidateVersion: datasetVersionSchema.nullable(),
    error: importSafeErrorSchema.nullable(),
  })
  .strict();
export type ImportSnapshot = z.infer<typeof importSnapshotSchema>;

export const importPageSchema = z
  .object({
    items: z.array(importSnapshotSchema),
    cursor: z.string().trim().min(1).max(2048).nullable(),
    activeDatasetVersion: datasetVersionSchema.nullable().optional(),
  })
  .strict();
export type ImportPage = z.infer<typeof importPageSchema>;
export const listImportsResponseSchema = importPageSchema;

export const importPartSchema = z
  .object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().trim().min(1).max(1024),
    checksumSha256: checksumSha256Schema,
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type ImportPart = z.infer<typeof importPartSchema>;

export const importPartsResponseSchema = z
  .object({ parts: z.array(importPartSchema) })
  .strict();
export type ImportPartsResponse = z.infer<typeof importPartsResponseSchema>;
export const listImportPartsResponseSchema = importPartsResponseSchema;

export const signImportPartsResponseSchema = z
  .object({
    parts: z.array(
      z
        .object({
          partNumber: z.number().int().min(1).max(10_000),
          url: z.url(),
          headers: z.record(z.string(), z.string()),
          expiresAt: importTimestampSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type SignImportPartsResponse = z.infer<
  typeof signImportPartsResponseSchema
>;

export const startImportResponseSchema = importSnapshotSchema;
export const getImportResponseSchema = importSnapshotSchema;
export const restartImportResponseSchema = importSnapshotSchema;
export const completeImportResponseSchema = importSnapshotSchema;

export const datasetActivationSchema = z
  .object({
    importId: importIdSchema,
    datasetVersion: datasetVersionSchema,
    activatedAt: importTimestampSchema,
    activatedBy: z.string().trim().min(1).max(256),
    changed: z.boolean(),
  })
  .strict();
export type DatasetActivation = z.infer<typeof datasetActivationSchema>;
export const activateImportBodySchema = z.object({}).strict();
export const activateImportResponseSchema = datasetActivationSchema;

export const opaqueIdSchema = z.string().trim().min(1).max(256);

export const idempotencyKeySchema = z.string().trim().min(1).max(128);

export const authCallbackQuerySchema = z
  .object({
    code: z.string().trim().min(1).max(4096),
    state: z.string().trim().min(1).max(1024),
  })
  .strict();

export const measurementSchema = z
  .object({
    status: z.enum(["measured", "estimated", "unknown"]),
    source: z.string().min(1),
    coverageRatio: z.number().min(0).max(1).nullable(),
    observedThrough: z.iso.datetime({ offset: true }).nullable(),
    scope: z
      .object({
        kind: z.enum(["global", "filtered", "segment"]),
        dimensions: z.record(z.string(), z.string()),
        observedCount: z.number().nonnegative().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Measurement = z.infer<typeof measurementSchema>;

export interface MeasuredValue {
  readonly value: number | null;
  readonly unit: string;
  readonly measurement: Measurement;
}

export interface IncidentDto {
  readonly id: string;
  readonly number: string | null;
  readonly title: string;
  readonly priority: "P1" | "P2" | "P3" | "P4";
  readonly status:
    "detected" | "investigating" | "confirmed" | "resolved" | "closed";
  readonly startedAt: string;
  readonly detectedAt: string | null;
  readonly endedAt: string | null;
  readonly impact: {
    readonly affectedDevices: MeasuredValue;
    readonly affectedSessions: MeasuredValue;
    readonly shareOfObservedSessions: MeasuredValue;
  };
  readonly primaryComponent: {
    readonly id: string;
    readonly name: string;
  } | null;
  readonly scopeSummary: readonly {
    readonly dimension: string;
    readonly value: string;
    readonly name: string;
  }[];
  readonly diagnosis: {
    readonly status:
      "not_started" | "processing" | "ready" | "inconclusive" | "failed";
    readonly primaryHypothesisId: string | null;
    readonly confidence: number | null;
    readonly reviewStatus: "pending" | "confirmed" | "refuted" | "inconclusive";
  };
}

export interface IncidentsData {
  readonly capabilities: FilteringCapabilities;
  readonly items: readonly IncidentDto[];
  readonly impactSeries: {
    readonly metric: "affected_devices" | "affected_sessions";
    readonly unit: "devices" | "sessions";
    readonly bucketSeconds: number;
    readonly measurement: Measurement;
    readonly points: readonly {
      readonly timestamp: string;
      readonly total: number;
      readonly byPriority: Readonly<Record<"P1" | "P2" | "P3" | "P4", number>>;
    }[];
  };
  readonly facets: Readonly<Record<string, readonly unknown[]>>;
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export interface FilteringCapabilities {
  readonly filtering: {
    readonly status: "available" | "partial" | "unavailable";
    readonly supportedDimensions: readonly string[];
    readonly supportedFilterSets: readonly (readonly string[])[];
  };
}

export interface DiagnosisData {
  readonly incident: IncidentDto;
  readonly diagnosis: {
    readonly status:
      "not_started" | "processing" | "ready" | "inconclusive" | "failed";
    readonly generatedAt: string | null;
    readonly summary: string | null;
    readonly primaryHypothesisId: string | null;
    readonly confidence: number | null;
    readonly hypotheses: readonly {
      readonly id: string;
      readonly rank: number;
      readonly statement: string;
      readonly component: { readonly id: string; readonly name: string } | null;
      readonly probability: number | null;
      readonly rationale: string | null;
      readonly review: {
        readonly status: "pending" | "confirmed" | "refuted" | "inconclusive";
        readonly note: string | null;
        readonly reviewedAt: string | null;
        readonly version: number;
      };
    }[];
  };
  readonly evidence: readonly EvidenceDto[];
  readonly charts: {
    readonly buffering: {
      readonly points: readonly {
        readonly timestamp: string;
        readonly value: number;
      }[];
      readonly marker: {
        readonly timestamp: string;
        readonly label: string;
      } | null;
    } | null;
    readonly concentrations: readonly {
      readonly label: string;
      readonly percentage: number;
    }[];
    readonly concentrationNote: string;
  };
  readonly timeline: readonly {
    readonly timestamp: string;
    readonly label: string;
    readonly source: string;
    readonly tone: "info" | "warning" | "critical" | "navy";
  }[];
  readonly changes: readonly {
    readonly label: string;
    readonly cause: string;
    readonly percentage: number;
    readonly tone: "info" | "warning" | "critical";
  }[];
  readonly dataQuality: {
    readonly status: "sufficient" | "limited" | "insufficient";
    readonly coverageRatio: number | null;
    readonly observedThrough: string | null;
    readonly gaps: readonly string[];
  };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface EventCorrelationDto {
  readonly correlationId: string;
  readonly incidentId: string;
  readonly ruleVersion: string;
  readonly timeDistanceSeconds: number;
  readonly matchedFields: readonly {
    readonly eventField: string;
    readonly incidentField: string;
    readonly value: string;
  }[];
}

export interface EventDto {
  readonly id: string;
  readonly datasetVersion: DatasetVersion;
  readonly category: "signal_observation" | "live_event" | "live_event_context";
  readonly source: {
    readonly system: string;
    readonly dataset: string;
    readonly recordId: string;
    readonly canonicalLocator: string;
  };
  readonly occurredAt: string | null;
  readonly window: {
    readonly start: string;
    readonly end: string;
    readonly grainSeconds: number;
  } | null;
  readonly dimensions: Readonly<Record<string, JsonValue>>;
  readonly measures: Readonly<Record<string, JsonValue>>;
  readonly correlation: {
    readonly status: "linked" | "unlinked";
    readonly incidentIds: readonly string[];
    readonly links: readonly EventCorrelationDto[];
  };
  readonly quality: {
    readonly status: "measured" | "partial" | "delayed" | "unavailable";
    readonly flags: readonly string[];
    readonly observedThrough: string | null;
  };
  readonly raw: { readonly available: boolean; readonly reason: string };
}

export interface EvidenceDto {
  readonly id: string;
  readonly eventId: string;
  readonly incidentId: string;
  readonly type: string;
  readonly relation: "supports" | "contradicts" | "context";
  readonly hypothesisIds: readonly string[];
  readonly strength: "strong" | "moderate" | "weak";
  readonly observedAt: string | null;
  readonly source: {
    readonly type: string;
    readonly name: string;
    readonly dataset: string;
    readonly recordId: string;
  };
  readonly correlation: EventCorrelationDto;
  readonly quality: {
    readonly status: "verified" | "partial" | "delayed" | "unavailable";
    readonly coverageRatio: number | null;
    readonly flags: readonly string[];
  };
}

export interface EventsData {
  readonly incident: {
    readonly id: string;
    readonly number: string | null;
    readonly title: string;
  } | null;
  readonly capabilities: FilteringCapabilities;
  readonly categoryStats: readonly {
    readonly category: EventDto["category"];
    readonly count: number;
  }[];
  readonly volumeSeries: {
    readonly bucketSeconds: number;
    readonly points: readonly {
      readonly timestamp: string;
      readonly count: number;
    }[];
  } | null;
  readonly items: readonly EventDto[];
  readonly facets: {
    readonly categories: readonly EventDto["category"][];
    readonly sourceDatasets: readonly string[];
    readonly correlationStatuses: readonly ("linked" | "unlinked")[];
  };
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export interface ReviewData {
  readonly incidentId: string;
  readonly hypothesisId: string;
  readonly review: {
    readonly status: "confirmed" | "refuted" | "inconclusive";
    readonly note: string | null;
    readonly reviewedAt: string;
    readonly version: number;
  };
}

export interface AuthenticatedIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: "viewer" | "engineer" | "admin";
}

export const authenticatedIdentitySchema = z
  .object({
    id: z.string().min(1),
    email: z.email(),
    name: z.string().nullable(),
    role: z.enum(["viewer", "engineer", "admin"]),
  })
  .strict();

export const measurementRuntimeSchema = z
  .object({
    status: z.enum(["measured", "estimated", "unknown"]),
    source: z.string().min(1),
    coverageRatio: z.number().min(0).max(1).nullable(),
    observedThrough: z.iso.datetime({ offset: true }).nullable(),
    scope: z
      .object({
        kind: z.enum(["global", "filtered", "segment"]),
        dimensions: z.record(z.string(), z.string()),
        observedCount: z.number().nonnegative().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const measuredValueSchema = z
  .object({
    value: z.number().nullable(),
    unit: z.string().min(1),
    measurement: measurementRuntimeSchema,
  })
  .strict();

export const incidentDtoSchema = z
  .object({
    id: z.string().min(1),
    number: z.string().nullable(),
    title: z.string().min(1),
    priority: z.enum(["P1", "P2", "P3", "P4"]),
    status: z.enum([
      "detected",
      "investigating",
      "confirmed",
      "resolved",
      "closed",
    ]),
    startedAt: z.iso.datetime({ offset: true }),
    detectedAt: z.iso.datetime({ offset: true }).nullable(),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    impact: z
      .object({
        affectedDevices: measuredValueSchema,
        affectedSessions: measuredValueSchema,
        shareOfObservedSessions: measuredValueSchema,
      })
      .strict(),
    primaryComponent: z
      .object({ id: z.string().min(1), name: z.string().min(1) })
      .strict()
      .nullable(),
    scopeSummary: z.array(
      z
        .object({
          dimension: z.string().min(1),
          value: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ),
    diagnosis: z
      .object({
        status: z.enum([
          "not_started",
          "processing",
          "ready",
          "inconclusive",
          "failed",
        ]),
        primaryHypothesisId: z.string().nullable(),
        confidence: z.number().min(0).max(1).nullable(),
        reviewStatus: z.enum([
          "pending",
          "confirmed",
          "refuted",
          "inconclusive",
        ]),
      })
      .strict(),
  })
  .strict();

const filteringCapabilitiesSchema = z
  .object({
    filtering: z
      .object({
        status: z.enum(["available", "partial", "unavailable"]),
        supportedDimensions: z.array(z.string()),
        supportedFilterSets: z.array(z.array(z.string())),
      })
      .strict(),
  })
  .strict();

export const incidentsDataSchema = z
  .object({
    capabilities: filteringCapabilitiesSchema,
    items: z.array(incidentDtoSchema),
    impactSeries: z
      .object({
        metric: z.enum(["affected_devices", "affected_sessions"]),
        unit: z.enum(["devices", "sessions"]),
        bucketSeconds: z.number().int().positive(),
        measurement: measurementRuntimeSchema,
        points: z.array(
          z
            .object({
              timestamp: z.iso.datetime({ offset: true }),
              total: z.number().nonnegative(),
              byPriority: z
                .object({
                  P1: z.number().nonnegative(),
                  P2: z.number().nonnegative(),
                  P3: z.number().nonnegative(),
                  P4: z.number().nonnegative(),
                })
                .strict(),
            })
            .strict(),
        ),
      })
      .strict(),
    facets: z.record(z.string(), z.array(z.unknown())),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const eventCorrelationSchema = z
  .object({
    correlationId: z.string().min(1),
    incidentId: z.string().min(1),
    ruleVersion: z.string().min(1),
    timeDistanceSeconds: z.number().int(),
    matchedFields: z.array(
      z
        .object({
          eventField: z.string().min(1),
          incidentField: z.string().min(1),
          value: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const eventDtoSchema = z
  .object({
    id: z.string().regex(/^evt_[a-z2-7]{26}$/),
    datasetVersion: datasetVersionSchema,
    category: z.enum([
      "signal_observation",
      "live_event",
      "live_event_context",
    ]),
    source: z
      .object({
        system: z.string().min(1),
        dataset: z.string().min(1),
        recordId: z.string().min(1),
        canonicalLocator: z.string().min(1),
      })
      .strict(),
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    window: z
      .object({
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
        grainSeconds: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    dimensions: z.record(z.string(), jsonValueSchema),
    measures: z.record(z.string(), jsonValueSchema),
    correlation: z
      .object({
        status: z.enum(["linked", "unlinked"]),
        incidentIds: z.array(z.string().min(1)),
        links: z.array(eventCorrelationSchema),
      })
      .strict(),
    quality: z
      .object({
        status: z.enum(["measured", "partial", "delayed", "unavailable"]),
        flags: z.array(z.string().min(1)),
        observedThrough: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
    raw: z
      .object({ available: z.boolean(), reason: z.string().min(1) })
      .strict(),
  })
  .strict();

export const evidenceDtoSchema = z
  .object({
    id: z.string().min(1),
    eventId: z.string().regex(/^evt_[a-z2-7]{26}$/),
    incidentId: z.string().min(1),
    type: z.string().min(1),
    relation: z.enum(["supports", "contradicts", "context"]),
    hypothesisIds: z.array(z.string()),
    strength: z.enum(["strong", "moderate", "weak"]),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
    source: z
      .object({
        type: z.string().min(1),
        name: z.string().min(1),
        dataset: z.string().min(1),
        recordId: z.string().min(1),
      })
      .strict(),
    correlation: eventCorrelationSchema,
    quality: z
      .object({
        status: z.enum(["verified", "partial", "delayed", "unavailable"]),
        coverageRatio: z.number().min(0).max(1).nullable(),
        flags: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export const diagnosisDataSchema = z
  .object({
    incident: incidentDtoSchema,
    diagnosis: z
      .object({
        status: z.enum([
          "not_started",
          "processing",
          "ready",
          "inconclusive",
          "failed",
        ]),
        generatedAt: z.iso.datetime({ offset: true }).nullable(),
        summary: z.string().nullable(),
        primaryHypothesisId: z.string().nullable(),
        confidence: z.number().min(0).max(1).nullable(),
        hypotheses: z.array(
          z
            .object({
              id: z.string().min(1),
              rank: z.number().int().positive(),
              statement: z.string().min(1),
              component: z
                .object({ id: z.string(), name: z.string() })
                .strict()
                .nullable(),
              probability: z.number().min(0).max(1).nullable(),
              rationale: z.string().nullable(),
              review: z
                .object({
                  status: z.enum([
                    "pending",
                    "confirmed",
                    "refuted",
                    "inconclusive",
                  ]),
                  note: z.string().nullable(),
                  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
                  version: z.number().int().nonnegative(),
                })
                .strict(),
            })
            .strict(),
        ),
      })
      .strict(),
    evidence: z.array(evidenceDtoSchema),
    charts: z
      .object({
        buffering: z
          .object({
            points: z.array(
              z
                .object({
                  timestamp: z.iso.datetime({ offset: true }),
                  value: z.number(),
                })
                .strict(),
            ),
            marker: z
              .object({
                timestamp: z.iso.datetime({ offset: true }),
                label: z.string(),
              })
              .strict()
              .nullable(),
          })
          .strict()
          .nullable(),
        concentrations: z.array(
          z.object({ label: z.string(), percentage: z.number() }).strict(),
        ),
        concentrationNote: z.string(),
      })
      .strict(),
    timeline: z.array(
      z
        .object({
          timestamp: z.iso.datetime({ offset: true }),
          label: z.string(),
          source: z.string(),
          tone: z.enum(["info", "warning", "critical", "navy"]),
        })
        .strict(),
    ),
    changes: z.array(
      z
        .object({
          label: z.string(),
          cause: z.string(),
          percentage: z.number(),
          tone: z.enum(["info", "warning", "critical"]),
        })
        .strict(),
    ),
    dataQuality: z
      .object({
        status: z.enum(["sufficient", "limited", "insufficient"]),
        coverageRatio: z.number().min(0).max(1).nullable(),
        observedThrough: z.iso.datetime({ offset: true }).nullable(),
        gaps: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export const eventsDataRuntimeSchema = z
  .object({
    incident: z
      .object({
        id: z.string(),
        number: z.string().nullable(),
        title: z.string(),
      })
      .strict()
      .nullable(),
    capabilities: filteringCapabilitiesSchema,
    categoryStats: z.array(
      z
        .object({
          category: z.enum([
            "signal_observation",
            "live_event",
            "live_event_context",
          ]),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    volumeSeries: z
      .object({
        bucketSeconds: z.number().int().positive(),
        points: z.array(
          z
            .object({
              timestamp: z.iso.datetime({ offset: true }),
              count: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    items: z.array(eventDtoSchema),
    facets: z
      .object({
        categories: z.array(
          z.enum(["signal_observation", "live_event", "live_event_context"]),
        ),
        sourceDatasets: z.array(z.string()),
        correlationStatuses: z.array(z.enum(["linked", "unlinked"])),
      })
      .strict(),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const reviewDataRuntimeSchema = z
  .object({
    incidentId: z.string(),
    hypothesisId: z.string(),
    review: z
      .object({
        status: z.enum(["confirmed", "refuted", "inconclusive"]),
        note: z.string().nullable(),
        reviewedAt: z.iso.datetime({ offset: true }),
        version: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const overviewProjectionSchema = z
  .object({
    capabilities: filteringCapabilitiesSchema,
    kpis: z.array(
      z
        .object({
          key: z.string().min(1),
          value: z.number().nullable(),
          unit: z.string().min(1),
          status: z.enum(["healthy", "warning", "critical", "unknown"]),
          comparison: z
            .object({
              baselineValue: z.number(),
              absoluteChange: z.number(),
              changeRatio: z.number(),
              direction: z.enum(["up", "down", "stable"]),
            })
            .strict()
            .nullable(),
          shareOfObservedSessions: z.number().min(0).max(1).optional(),
          measurement: measurementRuntimeSchema,
        })
        .strict(),
    ),
    experienceHealth: z
      .object({
        metric: z.literal("errors_per_minute"),
        unit: z.literal("errors_per_minute"),
        bucketSeconds: z.number().int().positive(),
        baselineValue: z.number().nullable(),
        measurement: measurementRuntimeSchema,
        points: z.array(
          z
            .object({
              timestamp: z.iso.datetime({ offset: true }),
              value: z.number().nonnegative(),
            })
            .strict(),
        ),
        anomalyWindows: z.array(
          z
            .object({
              from: z.iso.datetime({ offset: true }),
              to: z.iso.datetime({ offset: true }),
              peakTimestamp: z.iso.datetime({ offset: true }),
              peakValue: z.number().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    recentIncidents: z.array(
      z
        .object({
          id: z.string().min(1),
          number: z.string().nullable(),
          title: z.string().min(1),
          priority: z.enum(["P1", "P2", "P3", "P4"]),
          status: z.enum([
            "detected",
            "investigating",
            "confirmed",
            "resolved",
            "closed",
          ]),
          startedAt: z.iso.datetime({ offset: true }),
          affectedSessions: measuredValueSchema,
          primaryComponent: z
            .object({ id: z.string().min(1), name: z.string().min(1) })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    facets: z.record(z.string(), z.array(z.unknown())),
  })
  .strict();

const availabilitySchema = z.enum(["available", "partial", "unavailable"]);

const monitoringKpiSchema = z
  .object({
    value: z.number().nullable(),
    unit: z.string().min(1),
    status: z.enum(["healthy", "warning", "critical", "unknown"]),
    comparison: z
      .object({
        previousValue: z.number(),
        changeRatio: z.number(),
        direction: z.enum(["up", "down", "stable"]),
      })
      .strict()
      .nullable()
      .optional(),
    target: z
      .object({
        operator: z.enum([
          "less_than",
          "less_than_or_equal",
          "greater_than",
          "greater_than_or_equal",
        ]),
        value: z.number(),
      })
      .strict()
      .optional(),
    newInWindow: z.number().nonnegative().nullable().optional(),
    measurement: measurementRuntimeSchema,
  })
  .strict();

export const monitoringProjectionSchema = z
  .object({
    capabilities: z
      .object({
        sourceQuality: z.object({ status: availabilitySchema }).strict(),
        pipelineRuntime: z
          .object({
            status: availabilitySchema,
            metrics: z
              .object({
                ingestionRate: availabilitySchema,
                processingLatencyP95: availabilitySchema,
                queueDepth: availabilitySchema,
                deadLetterQueue: availabilitySchema,
              })
              .strict(),
            reason: z.string().nullable().optional(),
          })
          .strict(),
        geographicMetrics: z
          .object({
            status: availabilitySchema,
            granularity: z.literal("state"),
          })
          .strict(),
        filtering: filteringCapabilitiesSchema.shape.filtering,
      })
      .strict(),
    kpis: z
      .object({
        ingestionRate: monitoringKpiSchema,
        processingLatencyP95: monitoringKpiSchema,
        queueDepth: monitoringKpiSchema,
        deadLetterQueue: monitoringKpiSchema,
      })
      .strict(),
    flow: z
      .object({
        metric: z.enum(["ingestion_rate", "processing_latency"]),
        unit: z.string().min(1),
        bucketSeconds: z.number().int().positive(),
        measurement: measurementRuntimeSchema,
        target: z
          .object({
            operator: z.enum([
              "less_than",
              "less_than_or_equal",
              "greater_than",
              "greater_than_or_equal",
            ]),
            value: z.number(),
          })
          .strict()
          .nullable(),
        series: z.array(
          z
            .object({
              stage: z.string().min(1),
              name: z.string().min(1),
              points: z.array(
                z
                  .object({
                    timestamp: z.iso.datetime({ offset: true }),
                    value: z.number().nonnegative(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
        peak: z
          .object({
            timestamp: z.iso.datetime({ offset: true }),
            stage: z.string().min(1),
            value: z.number().nonnegative(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    sources: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          type: z.string().min(1),
          workers: z.array(z.string().min(1)),
          lastRunAt: z.iso.datetime({ offset: true }).nullable(),
          lastSuccessfulRunAt: z.iso.datetime({ offset: true }).nullable(),
          observedThrough: z.iso.datetime({ offset: true }).nullable(),
          lagSeconds: z.number().nonnegative().nullable(),
          state: z.enum(["stable", "delayed", "partial", "unavailable"]),
          records: z
            .object({
              read: z.number().nonnegative(),
              written: z.number().nonnegative(),
              rejected: z.number().nonnegative(),
              measurement: measurementRuntimeSchema,
            })
            .strict(),
          coverage: measuredValueSchema,
        })
        .strict(),
    ),
    geography: z
      .object({
        granularity: z.literal("state"),
        metrics: z.array(
          z
            .object({
              key: z.string().min(1),
              unit: z.string().min(1),
              status: availabilitySchema,
            })
            .strict(),
        ),
        areas: z.array(
          z
            .object({
              code: z.string().min(1),
              name: z.string().min(1),
              region: z.string().min(1),
              observedSessions: measuredValueSchema,
              coverageRatio: measuredValueSchema,
              values: z
                .object({
                  instabilityRatio: measuredValueSchema,
                  latencyP95: measuredValueSchema,
                  eventLossRatio: measuredValueSchema,
                })
                .strict(),
            })
            .strict(),
        ),
      })
      .strict(),
    facets: z.record(z.string(), z.array(z.unknown())),
  })
  .strict();

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const forbiddenPublicFields = new Set(["pk", "sk", "ttl", "LastEvaluatedKey"]);

export function assertNoPhysicalFields(value: unknown, path = "data"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPhysicalFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      forbiddenPublicFields.has(key) ||
      key.startsWith("gsi") ||
      key.startsWith("GSI")
    ) {
      throw new ServiceError(
        500,
        "INTERNAL_ERROR",
        `Campo físico detectado em ${path}.`,
      );
    }
    assertNoPhysicalFields(child, `${path}.${key}`);
  }
}

export function resolveWindow(
  preset: "15m" | "30m" | "1h" | "6h" | "24h",
  now: Date = new Date(),
): ResolvedWindow {
  const milliseconds = {
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "6h": 21_600_000,
    "24h": 86_400_000,
  }[preset];
  return {
    preset,
    from: new Date(now.getTime() - milliseconds).toISOString(),
    to: now.toISOString(),
  };
}

export function validationError(error: z.ZodError): ServiceError {
  return new ServiceError(
    400,
    "VALIDATION_ERROR",
    "Um ou mais parâmetros são inválidos.",
    error.issues.map((issue) => ({
      field: issue.path.join(".") || "request",
      code: issue.code,
      message: issue.message,
    })),
  );
}

let telemetrySdk: NodeSDK | null = null;

export function startTelemetry(serviceName: string): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  telemetrySdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  telemetrySdk.start();
}

export async function stopTelemetry(): Promise<void> {
  await telemetrySdk?.shutdown();
  telemetrySdk = null;
}

export interface Logger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const redactedKeys = new Set([
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactedKeys.has(key.toLowerCase()) ? "[REDACTED]" : redact(child),
    ]),
  );
}

function redactFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redact(fields) as Record<string, unknown>;
}

export function createLogger(serviceName: string): Logger {
  const write = (
    level: "info" | "warn" | "error",
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    const spanContext = trace.getActiveSpan()?.spanContext();
    const resolvedServiceName = process.env.OTEL_SERVICE_NAME ?? serviceName;
    const line = JSON.stringify({
      ...redactFields(fields),
      timestamp: new Date().toISOString(),
      level,
      service_name: resolvedServiceName,
      ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
      ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
      message,
    });
    process.stdout.write(`${line}\n`);

    const lokiPushUrl = process.env.LOKI_PUSH_URL;
    if (lokiPushUrl) {
      void fetch(lokiPushUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(2_000),
        body: JSON.stringify({
          streams: [
            {
              stream: {
                service_name: resolvedServiceName,
                level,
                environment:
                  process.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
                  process.env.NODE_ENV ??
                  "unknown",
              },
              values: [[`${Date.now()}000000`, line]],
            },
          ],
        }),
      }).catch(() => {
        // Remote logging is best-effort; stdout remains the durable fallback.
      });
    }
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export function requireInternalToken(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  expected: string,
): void {
  const provided = headers["x-internal-token"];
  if (
    typeof provided !== "string" ||
    provided.length === 0 ||
    provided !== expected
  ) {
    throw new ServiceError(403, "FORBIDDEN", "Chamada interna não autorizada.");
  }
}

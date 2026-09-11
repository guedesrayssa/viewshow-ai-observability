import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

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
  readonly quality: QualityContext;
}

export const internalResponseSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      data,
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

const temporalQueryShape = {
  window: windowPresetSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};

function validateTemporalQuery(value: {
  window?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): boolean {
  const custom = value.from !== undefined || value.to !== undefined;
  return custom
    ? value.from !== undefined &&
        value.to !== undefined &&
        value.window === undefined
    : true;
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
      "from e to devem ser enviados juntos e não podem ser combinados com window.",
  })
  .transform((value) => ({ ...value, window: value.window ?? "1h" }));
export type IncidentsQuery = z.output<typeof incidentsQuerySchema>;

export const eventsQuerySchema = z
  .object({
    ...temporalQueryShape,
    search: z.string().trim().max(100).optional(),
    category: z.string().optional(),
    deviceType: z.string().optional(),
    region: z.string().optional(),
    appVersion: z.string().optional(),
    source: z.string().optional(),
    os: z.string().optional(),
    state: z.string().optional(),
    pop: z.string().optional(),
    isp: z.string().optional(),
    cdn: z.string().optional(),
    content: z.string().optional(),
    component: z.string().optional(),
    environment: z.string().optional(),
    sort: z.enum(["recent", "oldest"]).default("recent"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
  .refine(validateTemporalQuery, {
    message:
      "from e to devem ser enviados juntos e não podem ser combinados com window.",
  })
  .transform((value) => ({ ...value, window: value.window ?? "30m" }));

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

export const startImportBodySchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 4),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    partCount: z.number().int().min(1).max(10_000),
  })
  .strict();
export type StartImportBody = z.infer<typeof startImportBodySchema>;

export const completeImportBodySchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(10_000),
            etag: z.string().trim().min(1).max(1024),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .refine(
    ({ parts }) =>
      new Set(parts.map(({ partNumber }) => partNumber)).size === parts.length,
    { message: "partNumber não pode se repetir." },
  );
export type CompleteImportBody = z.infer<typeof completeImportBodySchema>;

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
      readonly probability: number;
      readonly rationale: string | null;
      readonly review: {
        readonly status: "pending" | "confirmed" | "refuted" | "inconclusive";
        readonly note: string | null;
        readonly reviewedAt: string | null;
        readonly version: number;
      };
    }[];
  };
  readonly evidence: readonly {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly statement: string;
    readonly relation: "supports" | "contradicts" | "context";
    readonly hypothesisIds: readonly string[];
    readonly strength: "strong" | "moderate" | "weak";
    readonly observedAt: string | null;
    readonly source: { readonly type: string; readonly name: string };
    readonly quality: {
      readonly status: "verified" | "partial" | "delayed" | "unavailable";
      readonly coverageRatio: number | null;
      readonly flags: readonly string[];
    };
  }[];
  readonly charts: {
    readonly buffering: null;
    readonly concentrations: readonly unknown[];
  };
  readonly timeline: readonly unknown[];
  readonly dataQuality: {
    readonly status: "sufficient" | "limited" | "insufficient";
    readonly coverageRatio: number | null;
    readonly observedThrough: string | null;
    readonly gaps: readonly string[];
  };
}

export interface EventsData {
  readonly incident: {
    readonly id: string;
    readonly number: string | null;
    readonly title: string;
  };
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly categoryStats: readonly unknown[];
  readonly volumeSeries: Readonly<Record<string, unknown>> | null;
  readonly items: readonly unknown[];
  readonly facets: Readonly<Record<string, readonly unknown[]>>;
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
              probability: z.number().min(0).max(1),
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
    evidence: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          title: z.string(),
          statement: z.string(),
          relation: z.enum(["supports", "contradicts", "context"]),
          hypothesisIds: z.array(z.string()),
          strength: z.enum(["strong", "moderate", "weak"]),
          observedAt: z.iso.datetime({ offset: true }).nullable(),
          source: z.object({ type: z.string(), name: z.string() }).strict(),
          quality: z
            .object({
              status: z.enum(["verified", "partial", "delayed", "unavailable"]),
              coverageRatio: z.number().min(0).max(1).nullable(),
              flags: z.array(z.string()),
            })
            .strict(),
        })
        .strict(),
    ),
    charts: z
      .object({
        buffering: z.unknown().nullable(),
        concentrations: z.array(z.unknown()),
      })
      .strict(),
    timeline: z.array(z.unknown()),
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
      .strict(),
    capabilities: z.record(z.string(), z.unknown()),
    categoryStats: z.array(z.unknown()),
    volumeSeries: z.record(z.string(), z.unknown()).nullable(),
    items: z.array(z.unknown()),
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

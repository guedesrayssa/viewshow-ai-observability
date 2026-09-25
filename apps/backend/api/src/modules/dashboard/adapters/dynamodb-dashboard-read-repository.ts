import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  datasetVersionSchema,
  overviewProjectionSchema,
} from "@view-show/contracts";
import { z } from "zod";
import type { ActiveDatasetSnapshot } from "../../datasets/ports/active-dataset-resolver.js";
import type {
  DashboardReadRepository,
  ProjectionRead,
  PublicProjection,
} from "../ports/dashboard-read-repository.js";

type PhysicalItem = Readonly<Record<string, unknown>>;

const timestampSchema = z.iso.datetime({ offset: true });
const overviewPayloadSchema = z
  .object({
    projectionVersion: z.literal("1.0"),
    formulaVersion: z.string().min(1),
    inputWatermarks: z.record(z.string().min(1), timestampSchema),
    observedThrough: timestampSchema,
    coverage: z.enum(["complete", "partial", "unavailable"]),
    qualityFlags: z.array(z.string()),
    metrics: z
      .object({
        sessions: z.number().nonnegative().nullable(),
        errors: z.number().nonnegative().nullable(),
        startupErrors: z.number().nonnegative().nullable(),
        botErrors: z.number().nonnegative().nullable(),
        humanErrors: z.number().nonnegative().nullable(),
        errorRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
  })
  .strict();

const incidentSchema = z
  .object({
    incidentId: z.string().min(1),
    number: z.string().nullable(),
    openedAt: timestampSchema,
    state: z.string().nullable(),
    priority: z.enum(["P1", "P2", "P3", "P4", "1", "2", "3", "4"]).nullable(),
  })
  .strict();

const activeIncidentsPayloadSchema = z
  .object({
    projectionVersion: z.literal("1.0"),
    formulaVersion: z.string().min(1),
    inputWatermarks: z.record(z.string().min(1), timestampSchema),
    observedThrough: timestampSchema,
    coverage: z.enum(["complete", "partial", "unavailable"]),
    qualityFlags: z.array(z.string()),
    incidents: z.array(incidentSchema),
  })
  .strict();

const physicalProjectionSchema = z
  .object({
    pk: z.string().min(1),
    sk: z.string().min(1),
    entityType: z.literal("PROJECTION"),
    datasetVersion: datasetVersionSchema,
    partition: z.string().min(1),
    projectionPartitionKey: z.string().min(1),
    projectionKey: z.string().min(1),
    projectionVersion: z.literal("1.0"),
    materializationRevision: z.string().regex(/^pmr_[0-9a-f]{64}$/),
    requiredArchives: z.array(
      z
        .object({ dataset: z.string().min(1), partition: z.string().min(1) })
        .strict(),
    ),
    payload: z.unknown(),
    payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

type OverviewPhysicalRead = z.infer<typeof overviewPayloadSchema> & {
  readonly sourceDataset: string;
};

function coverageRatio(coverage: "complete" | "partial" | "unavailable") {
  return coverage === "complete" ? 1 : coverage === "unavailable" ? 0 : null;
}

function publicIncidentState(
  state: string | null,
): "detected" | "investigating" | "confirmed" | "resolved" | "closed" {
  switch (state?.toLowerCase()) {
    case "open":
    case "investigating":
      return "investigating";
    case "confirmed":
    case "acknowledged":
      return "confirmed";
    case "resolved":
      return "resolved";
    case "closed":
      return "closed";
    default:
      return "detected";
  }
}

function publicIncidentPriority(
  priority: "P1" | "P2" | "P3" | "P4" | "1" | "2" | "3" | "4" | null,
): "P1" | "P2" | "P3" | "P4" {
  if (priority === null) return "P4";
  return priority.startsWith("P")
    ? (priority as "P1" | "P2" | "P3" | "P4")
    : (`P${priority}` as "P1" | "P2" | "P3" | "P4");
}

function intervalDay(
  intervals: readonly { readonly start: string; readonly end: string }[],
): string | null {
  const latestEnd = intervals.reduce(
    (latest, interval) => Math.max(latest, Date.parse(interval.end)),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestEnd)) return null;
  return new Date(latestEnd - 1).toISOString().slice(0, 10).replaceAll("-", "");
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function publicProjection(item: PhysicalItem): PublicProjection | null {
  const candidate = item.publicData ?? item.projection;
  return candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
    ? (candidate as PublicProjection)
    : null;
}

function toRead(item: PhysicalItem): ProjectionRead | null {
  const data = publicProjection(item);
  if (!data) return null;
  return {
    data,
    observedThrough: text(item.observedThrough),
    coverageRatio: number(item.coverageRatio),
    source: text(item.source) ?? "argus",
  };
}

export class DynamoDashboardReadRepository implements DashboardReadRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    region: string,
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
    endpoint?: string,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region,
          ...(endpoint ? { endpoint } : {}),
        }),
        {
          marshallOptions: { removeUndefinedValues: true },
        },
      );
  }

  private async queryAll(
    input: Omit<QueryCommandInput, "TableName">,
  ): Promise<readonly PhysicalItem[]> {
    const items: PhysicalItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((result.Items ?? []) as PhysicalItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private async latestVersionedOverview(
    active: ActiveDatasetSnapshot,
    sourceDataset: string,
    day: string,
  ): Promise<OverviewPhysicalRead | null> {
    if (!/^[^#\s]+$/.test(sourceDataset)) return null;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :current)",
        ExpressionAttributeValues: {
          ":pk": `DATASET#${active.datasetVersion}#VIEW#OVERVIEW#${sourceDataset}#${day}`,
          ":current": "T#",
        },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    const parsed = physicalProjectionSchema.safeParse(result.Items?.[0]);
    if (!parsed.success) return null;
    if (
      parsed.data.datasetVersion !== active.datasetVersion ||
      parsed.data.projectionKey !== `OVERVIEW#${sourceDataset}` ||
      parsed.data.sk.startsWith("T#") === false
    )
      return null;
    const payload = overviewPayloadSchema.safeParse(parsed.data.payload);
    return payload.success ? { ...payload.data, sourceDataset } : null;
  }

  private async activeIncidents(active: ActiveDatasetSnapshot) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `DATASET#${active.datasetVersion}#VIEW#INCIDENTS#ACTIVE`,
          sk: "CURRENT",
        },
        ConsistentRead: true,
      }),
    );
    const parsed = physicalProjectionSchema.safeParse(result.Item);
    if (
      !parsed.success ||
      parsed.data.datasetVersion !== active.datasetVersion ||
      parsed.data.projectionKey !== "INCIDENTS#ACTIVE" ||
      parsed.data.sk !== "CURRENT"
    )
      return null;
    const payload = activeIncidentsPayloadSchema.safeParse(parsed.data.payload);
    return payload.success ? payload.data : null;
  }

  async activeOverview(
    active: ActiveDatasetSnapshot,
  ): Promise<ProjectionRead | null> {
    const candidates = await Promise.all(
      Object.entries(active.availableIntervals).map(
        ([sourceDataset, intervals]) => {
          const day = intervalDay(intervals);
          return day
            ? this.latestVersionedOverview(active, sourceDataset, day)
            : Promise.resolve(null);
        },
      ),
    );
    const reads = candidates.filter(
      (value): value is OverviewPhysicalRead => value !== null,
    );
    if (reads.length === 0) return null;
    reads.sort((left, right) => {
      const preferred =
        Number(right.sourceDataset === "live_qoe_hourly") -
        Number(left.sourceDataset === "live_qoe_hourly");
      return (
        preferred ||
        Date.parse(right.observedThrough) - Date.parse(left.observedThrough)
      );
    });
    const selected = reads[0]!;
    const source = `argus:${selected.sourceDataset}`;
    const ratio = coverageRatio(selected.coverage);
    const measured = (value: number | null) => ({
      status: value === null ? ("unknown" as const) : ("measured" as const),
      source,
      coverageRatio: ratio,
      observedThrough: selected.observedThrough,
      scope: {
        kind: "global" as const,
        dimensions: {},
        observedCount: selected.metrics.sessions,
      },
    });
    const kpis = [
      {
        key: "observed_sessions",
        value: selected.metrics.sessions,
        unit: "sessions",
        status: "healthy" as const,
        comparison: null,
        measurement: measured(selected.metrics.sessions),
      },
      {
        key: "errors",
        value: selected.metrics.errors,
        unit: "errors",
        status:
          selected.metrics.errorRate !== null &&
          selected.metrics.errorRate >= 0.1
            ? ("critical" as const)
            : selected.metrics.errorRate !== null &&
                selected.metrics.errorRate >= 0.05
              ? ("warning" as const)
              : ("healthy" as const),
        comparison: null,
        measurement: measured(selected.metrics.errors),
      },
      {
        key: "error_rate",
        value:
          selected.metrics.errorRate === null
            ? null
            : selected.metrics.errorRate * 100,
        unit: "percent",
        status:
          selected.metrics.errorRate !== null &&
          selected.metrics.errorRate >= 0.1
            ? ("critical" as const)
            : selected.metrics.errorRate !== null &&
                selected.metrics.errorRate >= 0.05
              ? ("warning" as const)
              : ("healthy" as const),
        comparison: null,
        measurement: measured(selected.metrics.errorRate),
      },
    ];
    const errorsPerMinute =
      selected.metrics.errors === null ? null : selected.metrics.errors / 60;
    const incidents = await this.activeIncidents(active);
    const incidentMeasurement = {
      status: "unknown" as const,
      source: "argus:incidents",
      coverageRatio: incidents ? coverageRatio(incidents.coverage) : null,
      observedThrough: incidents?.observedThrough ?? null,
    };
    const data = overviewProjectionSchema.parse({
      capabilities: {
        filtering: {
          status: "unavailable",
          supportedDimensions: [],
          supportedFilterSets: [],
        },
      },
      kpis,
      experienceHealth: {
        metric: "errors_per_minute",
        unit: "errors_per_minute",
        bucketSeconds: 3600,
        baselineValue: errorsPerMinute,
        measurement: measured(errorsPerMinute),
        points:
          errorsPerMinute === null
            ? []
            : [{ timestamp: selected.observedThrough, value: errorsPerMinute }],
        anomalyWindows: [],
      },
      recentIncidents: (incidents?.incidents ?? []).map((incident) => ({
        id: incident.incidentId,
        number: incident.number,
        title: incident.number ?? `Incidente ${incident.incidentId.slice(-8)}`,
        priority: publicIncidentPriority(incident.priority),
        status: publicIncidentState(incident.state),
        startedAt: incident.openedAt,
        affectedSessions: {
          value: null,
          unit: "sessions",
          measurement: incidentMeasurement,
        },
        primaryComponent: null,
      })),
      facets: {},
    });
    return {
      data,
      observedThrough: selected.observedThrough,
      coverageRatio: ratio,
      source,
    };
  }

  private daysBetween(from: Date, to: Date): string[] {
    const days: string[] = [];
    const first = new Date(from);
    first.setUTCHours(0, 0, 0, 0);
    const current = new Date(to);
    current.setUTCHours(0, 0, 0, 0);
    while (current >= first) {
      days.push(current.toISOString().slice(0, 10).replaceAll("-", ""));
      current.setUTCDate(current.getUTCDate() - 1);
    }
    return days;
  }

  async latestMonitoring(
    active: ActiveDatasetSnapshot,
    from: Date,
    to: Date,
    sources: readonly string[],
  ): Promise<ProjectionRead | null> {
    const reads = await Promise.all(
      sources
        .filter((source) => /^[^#\s]+$/.test(source))
        .flatMap((source) =>
          this.daysBetween(from, to).map(async (day) => {
            const items = await this.queryAll({
              KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
              ExpressionAttributeValues: {
                ":pk": `DATASET#${active.datasetVersion}#VIEW#MONITORING#${source}#${day}`,
                ":from": `T#${from.getTime()}`,
                ":to": `T#${to.getTime()}`,
              },
              ConsistentRead: true,
            });
            return items.map((item) => ({ item, source }));
          }),
        ),
    );
    const candidates = reads
      .flat()
      .sort((left, right) =>
        String(right.item.sk ?? "").localeCompare(String(left.item.sk ?? "")),
      );
    for (const { item, source } of candidates) {
      const parsed = physicalProjectionSchema.safeParse(item);
      if (
        !parsed.success ||
        parsed.data.datasetVersion !== active.datasetVersion ||
        parsed.data.projectionKey !== `MONITORING#${source}`
      )
        continue;
      const payload = parsed.data.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      )
        continue;
      return {
        data: payload as PublicProjection,
        observedThrough: text(
          (payload as Record<string, unknown>).observedThrough,
        ),
        coverageRatio: null,
        source,
      };
    }
    return null;
  }
}

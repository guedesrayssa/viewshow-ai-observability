import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  ServiceError,
  datasetVersionSchema,
  eventDtoSchema,
  evidenceDtoSchema,
  type EventDto,
  type EvidenceDto,
} from "@view-show/contracts";
import { z } from "zod";
import type { ActiveDatasetSnapshot } from "../../datasets/ports/active-dataset-resolver.js";
import { itemKind, type PhysicalItem } from "../domain/incident.js";
import type {
  ActiveIncidentProjection,
  EventProjectionStatus,
  EventReadPage,
  EventReadRequest,
  IncidentBundle,
  IncidentRepository,
  ReviewWrite,
} from "../ports/incident-repository.js";

const timestampSchema = z.iso.datetime({ offset: true });
const activeProjectionItemSchema = z
  .object({
    pk: z.string().min(1),
    sk: z.literal("CURRENT"),
    entityType: z.literal("PROJECTION"),
    datasetVersion: datasetVersionSchema,
    partition: z.string().min(1),
    projectionPartitionKey: z.string().min(1),
    projectionKey: z.literal("INCIDENTS#ACTIVE"),
    projectionVersion: z.literal("1.0"),
    materializationRevision: z.string().regex(/^pmr_[0-9a-f]{64}$/),
    requiredArchives: z.array(
      z
        .object({ dataset: z.string().min(1), partition: z.string().min(1) })
        .strict(),
    ),
    payload: z
      .object({
        projectionVersion: z.literal("1.0"),
        formulaVersion: z.string().min(1),
        inputWatermarks: z.record(z.string().min(1), timestampSchema),
        observedThrough: timestampSchema,
        coverage: z.enum(["complete", "partial", "unavailable"]),
        qualityFlags: z.array(z.string()),
        incidents: z.array(
          z
            .object({
              incidentId: z.string().min(1),
              number: z.string().nullable(),
              openedAt: timestampSchema,
              state: z.string().nullable(),
              priority: z
                .enum(["P1", "P2", "P3", "P4", "1", "2", "3", "4"])
                .nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ttl: z.number().int().positive().optional(),
  })
  .strict();

const eventProjectionItemSchema = z
  .object({
    pk: z.string().min(1),
    sk: z.string().min(1),
    entityType: z.enum([
      "EVENT",
      "EVENT_LOOKUP",
      "INCIDENT_EVENT",
      "EVIDENCE",
      "EVENT_PROJECTION_SUMMARY",
    ]),
    datasetVersion: datasetVersionSchema,
    materializationRevision: z.string().regex(/^pmr_[0-9a-f]{64}$/),
    payload: z.record(z.string(), z.unknown()),
    payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ttl: z.number().int().positive().optional(),
  })
  .strict();

const matchedFieldSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
]);

const storedCorrelationSchema = z
  .object({
    correlationId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    incidentId: z.string().min(1),
    ruleVersion: z.string().min(1),
    timeDistanceSeconds: z.number().int(),
    matchedFields: z.array(matchedFieldSchema),
  })
  .strict();

const storedEventPayloadSchema = z
  .object({
    eventId: z.string().min(1),
    datasetVersion: datasetVersionSchema,
    category: z.enum([
      "signal_observation",
      "live_event",
      "live_event_context",
    ]),
    sourceSystem: z.string().min(1),
    sourceDataset: z.string().min(1),
    sourceRecordId: z.string().min(1),
    canonicalLocator: z.string().min(1),
    occurredAt: timestampSchema.nullable(),
    sortAt: timestampSchema,
    window: z
      .object({
        start: timestampSchema,
        end: timestampSchema,
        grainSeconds: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    dimensions: z.record(z.string(), z.unknown()),
    measures: z.record(z.string(), z.unknown()),
    quality: z
      .object({
        status: z.enum(["measured", "partial", "delayed", "unavailable"]),
        flags: z.array(z.string()),
        observedThrough: timestampSchema.nullable(),
      })
      .strict(),
    raw: z
      .object({ available: z.boolean(), reason: z.string().min(1) })
      .strict(),
    correlationStatus: z.enum(["linked", "unlinked"]),
    incidentIds: z.array(z.string().min(1)),
    correlations: z.array(storedCorrelationSchema).optional(),
    correlation: storedCorrelationSchema.optional(),
  })
  .passthrough();

const storedEvidencePayloadSchema = z
  .object({
    evidenceId: z.string().min(1),
    eventId: z.string().min(1),
    incidentId: z.string().min(1),
    correlationId: z.string().min(1),
    ruleVersion: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1).nullable().optional(),
    statement: z.string().min(1).nullable().optional(),
    relation: z.enum(["supports", "contradicts", "context"]),
    strength: z.enum(["strong", "moderate", "weak"]),
    timeDistanceSeconds: z.number().int(),
    matchedFields: z.array(matchedFieldSchema),
    hypothesisIds: z.array(z.string()),
    eventOccurredAt: timestampSchema.nullable(),
    sourceDataset: z.string().min(1),
    sourceRecordId: z.string().min(1),
    observedThrough: timestampSchema.nullable(),
    coverage: z.enum(["COMPLETE", "PARTIAL", "UNAVAILABLE"]),
    qualityFlags: z.array(z.string()),
  })
  .passthrough();

const workerEvidenceFactSchema = z
  .object({
    itemType: z.literal("evidence"),
    id: z.string().min(1),
    scopeId: z.string().min(1),
    metric: z.string().min(1),
    unit: z.string().min(1),
    method: z.enum(["mean", "ratio-of-sums"]),
    start: timestampSchema,
    split: timestampSchema,
    end: timestampSchema,
    reference: z.number().nullable(),
    current: z.number().nullable(),
    referenceCount: z.number().int().nonnegative(),
    currentCount: z.number().int().nonnegative(),
    expectedPoints: z.number().int().positive(),
    direction: z.enum(["increase", "decrease", "stable", "unavailable"]),
    sourceIds: z.array(z.string().min(1)),
    statement: z.string().min(1),
    analysisRunId: z.string().min(1),
    createdAt: timestampSchema,
  })
  .passthrough();

const eventProjectionSummarySchema = z
  .object({
    observedThrough: timestampSchema.nullable(),
    coverage: z.enum(["COMPLETE", "PARTIAL", "UNAVAILABLE"]),
    qualityFlags: z.array(z.string()),
  })
  .passthrough();

function correlationDto(
  value: z.infer<typeof storedCorrelationSchema>,
): EventDto["correlation"]["links"][number] {
  return {
    correlationId: value.correlationId,
    incidentId: value.incidentId,
    ruleVersion: value.ruleVersion,
    timeDistanceSeconds: value.timeDistanceSeconds,
    matchedFields: value.matchedFields.map(
      ([eventField, incidentField, matchedValue]) => ({
        eventField,
        incidentField,
        value: matchedValue,
      }),
    ),
  };
}

function storedItem(value: unknown, datasetVersion: string) {
  const parsed = eventProjectionItemSchema.safeParse(value);
  if (!parsed.success || parsed.data.datasetVersion !== datasetVersion)
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "A projeção de eventos ativa contém um registro inválido.",
    );
  return parsed.data;
}

function eventDto(value: unknown, datasetVersion: string): EventDto {
  const item = storedItem(value, datasetVersion);
  const parsed = storedEventPayloadSchema.safeParse(item.payload);
  if (!parsed.success)
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "A projeção de eventos ativa contém um payload inválido.",
    );
  const payload = parsed.data;
  const links =
    payload.correlations ?? (payload.correlation ? [payload.correlation] : []);
  return eventDtoSchema.parse({
    id: payload.eventId,
    datasetVersion: payload.datasetVersion,
    category: payload.category,
    source: {
      system: payload.sourceSystem,
      dataset: payload.sourceDataset,
      recordId: payload.sourceRecordId,
      canonicalLocator: payload.canonicalLocator,
    },
    occurredAt: payload.occurredAt,
    window: payload.window,
    dimensions: payload.dimensions,
    measures: payload.measures,
    correlation: {
      status: payload.correlationStatus,
      incidentIds: payload.incidentIds,
      links: links.map(correlationDto),
    },
    quality: payload.quality,
    raw: payload.raw,
  });
}

function evidenceDto(value: unknown, datasetVersion: string): EvidenceDto {
  const item = storedItem(value, datasetVersion);
  const parsed = storedEvidencePayloadSchema.safeParse(item.payload);
  if (!parsed.success)
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "A projeção de evidências ativa contém um payload inválido.",
    );
  const payload = parsed.data;
  return evidenceDtoSchema.parse({
    id: payload.evidenceId,
    eventId: payload.eventId,
    incidentId: payload.incidentId,
    type: payload.type,
    title: payload.title ?? null,
    statement: payload.statement ?? null,
    relation: payload.relation,
    hypothesisIds: payload.hypothesisIds,
    strength: payload.strength,
    observedAt: payload.eventOccurredAt,
    source: {
      type: "argus_event",
      name: payload.sourceDataset,
      dataset: payload.sourceDataset,
      recordId: payload.sourceRecordId,
    },
    correlation: correlationDto({
      correlationId: payload.correlationId,
      eventId: payload.eventId,
      incidentId: payload.incidentId,
      ruleVersion: payload.ruleVersion,
      timeDistanceSeconds: payload.timeDistanceSeconds,
      matchedFields: payload.matchedFields,
    }),
    quality: {
      status:
        payload.coverage === "COMPLETE" && payload.qualityFlags.length === 0
          ? "verified"
          : payload.coverage === "UNAVAILABLE"
            ? "unavailable"
            : "partial",
      coverageRatio: payload.coverage === "COMPLETE" ? 1 : null,
      flags: payload.qualityFlags,
    },
  });
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function stableEventId(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      encoded += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (encoded.length === 26) break;
  }
  return `evt_${encoded}`;
}

function workerEvidenceDto(value: unknown, incidentId: string): EvidenceDto {
  const parsed = workerEvidenceFactSchema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "O diagnóstico ativo contém uma evidência analítica inválida.",
    );
  const fact = parsed.data;
  const coverageRatio = Math.min(
    1,
    fact.referenceCount / fact.expectedPoints,
    fact.currentCount / fact.expectedPoints,
  );
  const flags = [
    ...(coverageRatio < 1 ? ["ANALYSIS_FACT_PARTIAL_COVERAGE"] : []),
    ...(fact.reference === null || fact.current === null
      ? ["ANALYSIS_FACT_VALUE_UNAVAILABLE"]
      : []),
  ];
  return evidenceDtoSchema.parse({
    id: fact.id,
    eventId: stableEventId(`${incidentId}:${fact.id}`),
    incidentId,
    type: "analysis_fact",
    title: fact.metric,
    statement: fact.statement,
    relation: "context",
    hypothesisIds: [],
    strength:
      flags.length > 0
        ? "weak"
        : fact.direction === "stable"
          ? "moderate"
          : "strong",
    observedAt: fact.end,
    source: {
      type: "analysis_worker",
      name: "Análise automatizada",
      dataset: "analysis_context",
      recordId: fact.id,
    },
    correlation: {
      correlationId: `cor_${createHash("sha256")
        .update(`${incidentId}:${fact.id}`)
        .digest("hex")
        .slice(0, 24)}`,
      incidentId,
      ruleVersion: "analysis-fact-v1",
      timeDistanceSeconds: 0,
      matchedFields: [
        { eventField: "metric", incidentField: "metric", value: fact.metric },
        {
          eventField: "scopeId",
          incidentField: "scopeId",
          value: fact.scopeId,
        },
      ],
    },
    quality: {
      status: flags.length === 0 ? "verified" : "partial",
      coverageRatio,
      flags,
    },
  });
}

function daysBetween(from: string, to: string, recent: boolean): string[] {
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const finish = new Date(to);
  finish.setUTCHours(0, 0, 0, 0);
  if (start > finish)
    throw new ServiceError(
      400,
      "VALIDATION_ERROR",
      "O início da janela de Eventos deve ser anterior ao fim.",
    );
  const dayCount =
    Math.floor((finish.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount > 3_660)
    throw new ServiceError(
      400,
      "VALIDATION_ERROR",
      "A janela de Eventos excede o limite operacional de dez anos.",
    );
  const days: string[] = [];
  for (
    const day = new Date(start);
    day <= finish;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    days.push(day.toISOString().slice(0, 10).replaceAll("-", ""));
  return recent ? days.reverse() : days;
}

const MAX_EVALUATED_EVENT_ITEMS = 10_000;

type EventCandidate = {
  readonly event: EventDto;
  readonly day: string;
  readonly sortKey: string;
};

function matchesEventFilters(
  candidate: EventCandidate,
  request: EventReadRequest,
  omit?: "category" | "sourceDataset" | "correlation",
): boolean {
  const { event } = candidate;
  if (
    omit !== "category" &&
    request.category &&
    event.category !== request.category
  )
    return false;
  if (
    omit !== "sourceDataset" &&
    request.sourceDataset &&
    event.source.dataset !== request.sourceDataset
  )
    return false;
  if (
    omit !== "correlation" &&
    request.correlation !== "all" &&
    event.correlation.status !== request.correlation
  )
    return false;
  return true;
}

function priority(
  value: "P1" | "P2" | "P3" | "P4" | "1" | "2" | "3" | "4" | null,
): "P1" | "P2" | "P3" | "P4" {
  if (value === null) return "P4";
  if (value === "P1" || value === "1") return "P1";
  if (value === "P2" || value === "2") return "P2";
  if (value === "P3" || value === "3") return "P3";
  return "P4";
}

export class DynamoIncidentRepository implements IncidentRepository {
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

  async activeProjection(
    active: ActiveDatasetSnapshot,
  ): Promise<ActiveIncidentProjection | null> {
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
    const parsed = activeProjectionItemSchema.safeParse(result.Item);
    if (
      !parsed.success ||
      parsed.data.datasetVersion !== active.datasetVersion ||
      parsed.data.pk !==
        `DATASET#${active.datasetVersion}#VIEW#INCIDENTS#ACTIVE`
    )
      return null;
    return {
      observedThrough: parsed.data.payload.observedThrough,
      coverage: parsed.data.payload.coverage,
      incidents: parsed.data.payload.incidents.map((incident) => ({
        ...incident,
        priority: priority(incident.priority),
      })),
    };
  }

  async eventProjection(
    active: ActiveDatasetSnapshot,
  ): Promise<EventProjectionStatus | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `DATASET#${active.datasetVersion}#VIEW#EVENTS`,
          sk: "SUMMARY",
        },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const item = storedItem(result.Item, active.datasetVersion);
    if (
      item.entityType !== "EVENT_PROJECTION_SUMMARY" ||
      item.pk !== `DATASET#${active.datasetVersion}#VIEW#EVENTS` ||
      item.sk !== "SUMMARY"
    )
      return null;
    const parsed = eventProjectionSummarySchema.safeParse(item.payload);
    if (!parsed.success) return null;
    return {
      observedThrough: parsed.data.observedThrough,
      coverage:
        parsed.data.coverage.toLowerCase() as EventProjectionStatus["coverage"],
      qualityFlags: parsed.data.qualityFlags,
    };
  }

  async listEvents(
    active: ActiveDatasetSnapshot,
    request: EventReadRequest,
  ): Promise<EventReadPage> {
    const categoryCounts = new Map<EventDto["category"], number>();
    const sourceDatasets = new Set<string>();
    const correlationStatuses = new Set<"linked" | "unlinked">();
    const candidates: EventCandidate[] = [];
    let evaluated = 0;
    const fromEpoch = Date.parse(request.from);
    const toEpoch = Date.parse(request.to);
    const days =
      request.incidentId === null
        ? daysBetween(request.from, request.to, request.sort === "recent")
        : ["incident"];

    for (const day of days) {
      const pk = request.incidentId
        ? `DATASET#${active.datasetVersion}#INCIDENT#${request.incidentId}`
        : `DATASET#${active.datasetVersion}#VIEW#EVENTS#DAY#${day}`;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const response = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: request.incidentId
              ? "pk = :pk AND begins_with(sk, :prefix)"
              : "pk = :pk",
            ExpressionAttributeValues: request.incidentId
              ? { ":pk": pk, ":prefix": "EVENT#" }
              : { ":pk": pk },
            ScanIndexForward: request.sort !== "recent",
            ExclusiveStartKey: exclusiveStartKey,
            Limit: Math.min(1_000, MAX_EVALUATED_EVENT_ITEMS - evaluated + 1),
          }),
        );
        for (const raw of response.Items ?? []) {
          evaluated += 1;
          if (evaluated > MAX_EVALUATED_EVENT_ITEMS)
            throw new ServiceError(
              422,
              "VALIDATION_ERROR",
              "A consulta de Eventos é ampla demais; reduza o período ou os filtros.",
            );
          const item = storedItem(raw, active.datasetVersion);
          if (
            item.entityType !==
            (request.incidentId ? "INCIDENT_EVENT" : "EVENT")
          )
            continue;
          const event = eventDto(item, active.datasetVersion);
          const eventTime =
            event.occurredAt ??
            storedEventPayloadSchema.parse(item.payload).sortAt;
          const eventEpoch = Date.parse(eventTime);
          if (eventEpoch < fromEpoch || eventEpoch > toEpoch) continue;
          if (
            request.search &&
            !JSON.stringify(event)
              .toLocaleLowerCase("pt-BR")
              .includes(request.search.toLocaleLowerCase("pt-BR"))
          )
            continue;
          candidates.push({ event, day, sortKey: item.sk });
        }
        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
    }

    for (const candidate of candidates) {
      if (matchesEventFilters(candidate, request, "category"))
        categoryCounts.set(
          candidate.event.category,
          (categoryCounts.get(candidate.event.category) ?? 0) + 1,
        );
      if (matchesEventFilters(candidate, request, "sourceDataset"))
        sourceDatasets.add(candidate.event.source.dataset);
      if (matchesEventFilters(candidate, request, "correlation"))
        correlationStatuses.add(candidate.event.correlation.status);
    }
    const accepted = candidates.filter((candidate) =>
      matchesEventFilters(candidate, request),
    );
    let offset = 0;
    if (request.position) {
      const position = accepted.findIndex(
        (candidate) =>
          candidate.day === request.position?.day &&
          candidate.sortKey === request.position.sortKey,
      );
      if (position < 0)
        throw new ServiceError(
          400,
          "VALIDATION_ERROR",
          "O cursor de Eventos não pertence ao resultado atual.",
        );
      offset = position + 1;
    }
    const pageItems = accepted.slice(offset, offset + request.limit);
    const last = pageItems.at(-1);
    return {
      items: pageItems.map(({ event }) => event),
      categoryStats: [...categoryCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => ({ category, count })),
      facets: {
        categories: [...categoryCounts.keys()].sort(),
        sourceDatasets: [...sourceDatasets].sort(),
        correlationStatuses: [...correlationStatuses].sort(),
      },
      next:
        offset + request.limit < accepted.length && last
          ? { day: last.day, sortKey: last.sortKey }
          : null,
    };
  }

  async getEvent(
    active: ActiveDatasetSnapshot,
    eventId: string,
    incidentId: string | null,
  ): Promise<EventDto | null> {
    if (incidentId === null) {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            pk: `DATASET#${active.datasetVersion}#EVENT#${eventId}`,
            sk: "CURRENT",
          },
          ConsistentRead: true,
        }),
      );
      if (!result.Item) return null;
      const item = storedItem(result.Item, active.datasetVersion);
      if (item.entityType !== "EVENT_LOOKUP") return null;
      return eventDto(item, active.datasetVersion);
    }
    const items = await this.queryAll({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `DATASET#${active.datasetVersion}#INCIDENT#${incidentId}`,
        ":prefix": "EVENT#",
      },
    });
    for (const raw of items) {
      const item = storedItem(raw, active.datasetVersion);
      if (item.entityType !== "INCIDENT_EVENT") continue;
      const event = eventDto(item, active.datasetVersion);
      if (event.id === eventId) return event;
    }
    return null;
  }

  async listEvidence(
    active: ActiveDatasetSnapshot,
    incidentId: string,
    analysisRunId?: string,
  ): Promise<readonly EvidenceDto[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `DATASET#${active.datasetVersion}#INCIDENT#${incidentId}`,
        ":prefix": "EVIDENCE#",
      },
      ScanIndexForward: false,
    });
    return items.flatMap((item) => {
      if (item.entityType === "EVIDENCE")
        return [evidenceDto(item, active.datasetVersion)];
      if (item.itemType === "evidence") {
        // Fatos A′ de execuções anteriores continuam gravados, mas o diagnóstico
        // exibido cita só os da execução mais recente.
        if (analysisRunId !== undefined && item.analysisRunId !== analysisRunId)
          return [];
        return [workerEvidenceDto(item, incidentId)];
      }
      return [];
    });
  }

  async listHypotheses(
    active: ActiveDatasetSnapshot,
    incidentId: string,
  ): Promise<readonly PhysicalItem[]> {
    return this.queryAll({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `DATASET#${active.datasetVersion}#INCIDENT#${incidentId}`,
        ":prefix": "HYPOTHESIS#",
      },
    });
  }

  async latestDiagnosis(
    active: ActiveDatasetSnapshot,
    incidentId: string,
  ): Promise<PhysicalItem | null> {
    const items = await this.queryAll({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `DATASET#${active.datasetVersion}#INCIDENT#${incidentId}`,
        ":prefix": "DIAGNOSIS#",
      },
    });
    return (
      [...items].sort((left, right) => {
        const leftPublishedAt =
          typeof left.publishedAt === "string"
            ? left.publishedAt
            : typeof left.createdAt === "string"
              ? left.createdAt
              : "";
        const rightPublishedAt =
          typeof right.publishedAt === "string"
            ? right.publishedAt
            : typeof right.createdAt === "string"
              ? right.createdAt
              : "";
        return (
          rightPublishedAt.localeCompare(leftPublishedAt) ||
          String(right.sk ?? "").localeCompare(String(left.sk ?? ""))
        );
      })[0] ?? null
    );
  }

  private async queryAll(
    input: Omit<QueryCommandInput, "TableName">,
  ): Promise<readonly PhysicalItem[]> {
    const items: PhysicalItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((response.Items ?? []) as PhysicalItem[]));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  async listBetween(from: Date, to: Date): Promise<readonly PhysicalItem[]> {
    const manifest = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
        ConsistentRead: true,
      }),
    );
    const activeDataset =
      typeof manifest.Item?.activeDatasetVersion === "string"
        ? manifest.Item.activeDatasetVersion
        : null;
    const partitions: { readonly pk: string; readonly prefix?: string }[] = [];
    if (!activeDataset) {
      const firstHour = new Date(from);
      firstHour.setUTCMinutes(0, 0, 0);
      const hour = new Date(to);
      hour.setUTCMinutes(0, 0, 0);
      while (hour >= firstHour) {
        partitions.push({
          pk: `INC#${hour.toISOString().slice(0, 13)}`,
          prefix: "INCIDENT#",
        });
        hour.setUTCHours(hour.getUTCHours() - 1);
      }
    }
    const firstDay = new Date(from);
    firstDay.setUTCHours(0, 0, 0, 0);
    const day = new Date(to);
    day.setUTCHours(0, 0, 0, 0);
    while (day >= firstDay) {
      const suffix = `VIEW#INCIDENTS#DAY#${day.toISOString().slice(0, 10).replaceAll("-", "")}`;
      partitions.push({
        pk: activeDataset ? `DATASET#${activeDataset}#${suffix}` : suffix,
      });
      day.setUTCDate(day.getUTCDate() - 1);
    }

    const pages = await Promise.all(
      partitions.map(({ pk, prefix }) =>
        this.queryAll({
          KeyConditionExpression: prefix
            ? "pk = :pk AND begins_with(sk, :prefix)"
            : "pk = :pk",
          ExpressionAttributeValues: prefix
            ? { ":pk": pk, ":prefix": prefix }
            : { ":pk": pk },
        }),
      ),
    );

    const unique = new Map<string, PhysicalItem>();
    for (const item of pages.flat()) {
      if (itemKind(item) !== "incident") continue;
      const id =
        typeof item.id === "string"
          ? item.id
          : typeof item.incidentId === "string"
            ? item.incidentId
            : null;
      if (!id) continue;
      const current = unique.get(id);
      const timestamp =
        typeof item.updatedAt === "string"
          ? item.updatedAt
          : typeof item.startedAt === "string"
            ? item.startedAt
            : "";
      const currentTimestamp =
        typeof current?.updatedAt === "string"
          ? current.updatedAt
          : typeof current?.startedAt === "string"
            ? current.startedAt
            : "";
      if (!current || timestamp >= currentTimestamp) unique.set(id, item);
    }
    return [...unique.values()];
  }

  async bundle(incidentId: string): Promise<IncidentBundle> {
    const items = await this.queryAll({
      IndexName: "trace-index",
      KeyConditionExpression: "trace_id = :incidentId",
      ExpressionAttributeValues: { ":incidentId": incidentId },
    });
    return {
      incident: items.find((item) => itemKind(item) === "incident") ?? null,
      children: items.filter((item) => itemKind(item) !== "incident"),
    };
  }

  async writeReview(write: ReviewWrite): Promise<PhysicalItem> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: write.key,
          UpdateExpression:
            "SET reviewStatus = :status, reviewNote = :note, reviewedBy = :reviewer, reviewedAt = :reviewedAt, reviewVersion = :nextVersion",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_exists(sk) AND ((attribute_not_exists(reviewVersion) AND :expectedVersion = :zero) OR reviewVersion = :expectedVersion)",
          ExpressionAttributeValues: {
            ":status": write.status,
            ":note": write.note,
            ":reviewer": write.reviewerId,
            ":reviewedAt": write.reviewedAt,
            ":expectedVersion": write.expectedVersion,
            ":nextVersion": write.expectedVersion + 1,
            ":zero": 0,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      if (!result.Attributes)
        throw new ServiceError(
          500,
          "INTERNAL_ERROR",
          "A revisão não foi persistida.",
        );
      return result.Attributes;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new ServiceError(
          409,
          "REVIEW_VERSION_CONFLICT",
          "A hipótese foi revisada por outra sessão.",
        );
      }
      throw error;
    }
  }
}

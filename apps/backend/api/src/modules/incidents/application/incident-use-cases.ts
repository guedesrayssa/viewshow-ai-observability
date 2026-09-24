import {
  ServiceError,
  fingerprint,
  resolveWindow,
  type DiagnosisData,
  type EventsData,
  type EventData,
  eventItemRuntimeSchema,
  type IncidentsData,
  type IncidentsQuery,
  type InternalResponse,
  type ReviewBody,
  type ReviewData,
  type Warning,
} from "@view-show/contracts";
import { CursorCodec } from "../domain/cursor.js";
import {
  hypothesisId,
  itemKind,
  latestHypothesis,
  toDiagnosisData,
  toIncidentDto,
  type PhysicalItem,
} from "../domain/incident.js";
import type {
  IncidentRepository,
  ReanalysisPublisherPort,
  ReviewFeedbackPort,
} from "../ports/incident-repository.js";

const supportedDimensions = ["deviceType", "region", "appVersion"] as const;
const supportedFilterSets = [
  [],
  ["deviceType"],
  ["region"],
  ["appVersion"],
] as const;

const capabilities = {
  filtering: {
    status: "partial" as const,
    supportedDimensions,
    supportedFilterSets,
  },
};

type EventQuery = {
  readonly limit: number;
  readonly window: "15m" | "30m" | "1h" | "6h" | "24h";
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly category?: string | undefined;
  readonly deviceType?: string | undefined;
  readonly region?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly source?: string | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | undefined;
  readonly sort?: "recent" | "oldest" | undefined;
  readonly os?: string | undefined;
  readonly state?: string | undefined;
  readonly pop?: string | undefined;
  readonly isp?: string | undefined;
  readonly cdn?: string | undefined;
  readonly content?: string | undefined;
  readonly environment?: string | undefined;
};

function presentDimensions(query: IncidentsQuery): string[] {
  return supportedDimensions.filter(
    (dimension) => query[dimension] !== undefined,
  );
}

function ensureSupported(query: IncidentsQuery): void {
  if (presentDimensions(query).length > 1) {
    throw new ServiceError(
      422,
      "UNSUPPORTED_FILTER_COMBINATION",
      "A origem atual não permite combinar estes filtros.",
    );
  }
  const unsupported = [
    "os",
    "state",
    "isp",
    "cdn",
    "content",
    "component",
    "eventType",
  ].filter((key) => query[key as keyof IncidentsQuery] !== undefined);
  if (unsupported.length) {
    throw new ServiceError(
      422,
      "UNSUPPORTED_FILTER_COMBINATION",
      "A origem atual não sustenta um ou mais filtros solicitados.",
    );
  }
}

function temporalRange(
  query: IncidentsQuery,
  now: Date,
): { readonly from: Date; readonly to: Date; readonly preset: string | null } {
  if (query.from && query.to)
    return { from: new Date(query.from), to: new Date(query.to), preset: null };
  const window = resolveWindow(query.window, now);
  return {
    from: new Date(window.from),
    to: new Date(window.to),
    preset: window.preset,
  };
}

function filtersMatch(
  item: PhysicalItem,
  query: IncidentsQuery,
  from: Date,
  to: Date,
  now: Date,
): boolean {
  const incident = toIncidentDto(item, [], now);
  const started = new Date(incident.startedAt);
  if (started < from || started > to) return false;
  if (query.deviceType && item.deviceType !== query.deviceType) return false;
  if (query.region && item.region !== query.region) return false;
  if (query.appVersion && item.appVersion !== query.appVersion) return false;
  if (query.priority && !query.priority.split(",").includes(incident.priority))
    return false;
  if (query.status && !query.status.split(",").includes(incident.status))
    return false;
  if (query.search) {
    const haystack = [
      incident.number,
      incident.title,
      incident.primaryComponent?.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("pt-BR");
    if (!haystack.includes(query.search.toLocaleLowerCase("pt-BR")))
      return false;
  }
  return true;
}

function sortItems(
  items: readonly ReturnType<typeof toIncidentDto>[],
  sort: IncidentsQuery["sort"],
): ReturnType<typeof toIncidentDto>[] {
  return [...items].sort((left, right) => {
    if (sort === "priority")
      return (
        left.priority.localeCompare(right.priority) ||
        (right.impact.affectedDevices.value ?? -1) -
          (left.impact.affectedDevices.value ?? -1) ||
        right.startedAt.localeCompare(left.startedAt)
      );
    if (sort === "impact")
      return (
        (right.impact.affectedDevices.value ?? -1) -
        (left.impact.affectedDevices.value ?? -1)
      );
    return right.startedAt.localeCompare(left.startedAt);
  });
}

function facets(items: readonly ReturnType<typeof toIncidentDto>[]) {
  const aggregate = (values: readonly (string | null)[]) =>
    [...new Set(values.filter((value): value is string => value !== null))].map(
      (value) => ({
        value,
        name: value,
        count: values.filter((candidate) => candidate === value).length,
        measurement: {
          status: "measured" as const,
          source: "operational-read-model",
          coverageRatio: null,
          observedThrough: null,
        },
      }),
    );
  return {
    priorities: aggregate(items.map((item) => item.priority)),
    statuses: aggregate(items.map((item) => item.status)),
    deviceTypes: aggregate(
      items.map(
        (item) =>
          item.scopeSummary.find((scope) => scope.dimension === "deviceType")
            ?.value ?? null,
      ),
    ),
    appVersions: aggregate(
      items.map(
        (item) =>
          item.scopeSummary.find((scope) => scope.dimension === "appVersion")
            ?.value ?? null,
      ),
    ),
    regions: aggregate(
      items.map(
        (item) =>
          item.scopeSummary.find((scope) => scope.dimension === "region")
            ?.value ?? null,
      ),
    ),
  };
}

export class IncidentUseCases {
  constructor(
    private readonly repository: IncidentRepository,
    private readonly cursor: CursorCodec,
    private readonly feedback: ReviewFeedbackPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly reanalysis: ReanalysisPublisherPort = new UnavailableReanalysisPublisherPort(),
  ) {}

  async list(query: IncidentsQuery): Promise<InternalResponse<IncidentsData>> {
    ensureSupported(query);
    const now = this.clock();
    const range = temporalRange(query, now);
    const physical = await this.repository.listBetween(range.from, range.to);
    const filtered = physical.filter((item) =>
      filtersMatch(item, query, range.from, range.to, now),
    );
    const incidents = sortItems(
      filtered.map((item) => toIncidentDto(item, [], now)),
      query.sort,
    );
    const cursorFingerprint = fingerprint({ ...query, cursor: undefined });
    const offset = query.cursor
      ? this.cursor.decode(query.cursor, cursorFingerprint)
      : 0;
    const items = incidents.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < incidents.length;
    const measuredDevices = incidents
      .map((item) => item.impact.affectedDevices.value)
      .filter((value): value is number => value !== null);
    const measuredSessions = incidents
      .map((item) => item.impact.affectedSessions.value)
      .filter((value): value is number => value !== null);
    const selected =
      query.chartMetric === "affected_devices"
        ? measuredDevices
        : measuredSessions;
    const points = new Map<
      string,
      { total: number; byPriority: Record<"P1" | "P2" | "P3" | "P4", number> }
    >();
    for (const item of incidents) {
      const value =
        query.chartMetric === "affected_devices"
          ? item.impact.affectedDevices.value
          : item.impact.affectedSessions.value;
      if (value === null) continue;
      const date = new Date(item.startedAt);
      date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15, 0, 0);
      const timestamp = date.toISOString();
      const bucket = points.get(timestamp) ?? {
        total: 0,
        byPriority: { P1: 0, P2: 0, P3: 0, P4: 0 },
      };
      bucket.total += value;
      bucket.byPriority[item.priority] += value;
      points.set(timestamp, bucket);
    }
    const warnings: Warning[] =
      selected.length === 0
        ? [
            {
              code: "IMPACT_MEASUREMENT_UNAVAILABLE",
              message: "O read model não contém a medição solicitada.",
            },
          ]
        : [];
    return {
      data: {
        capabilities,
        items,
        impactSeries: {
          metric: query.chartMetric,
          unit:
            query.chartMetric === "affected_devices" ? "devices" : "sessions",
          bucketSeconds: 900,
          measurement: {
            status: selected.length
              ? query.chartMetric === "affected_devices"
                ? "estimated"
                : "measured"
              : "unknown",
            source: "operational-read-model",
            coverageRatio: null,
            observedThrough: null,
          },
          points: [...points]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([timestamp, bucket]) => ({ timestamp, ...bucket })),
        },
        facets: facets(incidents),
        page: {
          limit: query.limit,
          hasMore,
          nextCursor: hasMore
            ? this.cursor.encode(nextOffset, cursorFingerprint)
            : null,
        },
      },
      quality: {
        window: {
          preset: range.preset,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
        },
        partial: warnings.length > 0,
        refreshAfterSeconds: 900,
        freshness: [],
        warnings,
      },
    };
  }

  async diagnosis(
    incidentId: string,
  ): Promise<InternalResponse<DiagnosisData>> {
    const bundle = await this.repository.bundle(incidentId);
    if (!bundle.incident)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidente não encontrado.",
      );
    const data = toDiagnosisData(
      bundle.incident,
      bundle.children,
      this.clock(),
    );
    const unavailable = data.diagnosis.status === "not_started";
    return {
      data,
      quality: {
        window: null,
        partial: unavailable || data.dataQuality.status !== "sufficient",
        refreshAfterSeconds: 900,
        freshness: [],
        warnings: unavailable
          ? [
              {
                code: "AGENTIC_RESULT_UNAVAILABLE",
                message:
                  "Nenhum diagnóstico agêntico persistido está disponível para este incidente.",
              },
            ]
          : data.dataQuality.gaps.map((code) => ({
              code,
              message: "Uma projeção complementar ainda não está disponível.",
            })),
      },
    };
  }

  async events(
    incidentId: string,
    query: EventQuery,
  ): Promise<InternalResponse<EventsData>> {
    const unsupported = ["os", "state", "pop", "isp", "cdn", "content", "environment"]
      .filter((key) => query[key as keyof EventQuery] !== undefined);
    if (unsupported.length > 0)
      throw new ServiceError(422, "UNSUPPORTED_FILTER_COMBINATION", "A fonte de eventos não sustenta os filtros solicitados.");
    const bundle = await this.repository.bundle(incidentId);
    if (!bundle.incident)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidente não encontrado.",
      );
    const incident = toIncidentDto(
      bundle.incident,
      bundle.children.filter((item) => itemKind(item) === "hypothesis"),
      this.clock(),
    );
    const range = query.from && query.to
      ? { from: query.from, to: query.to, preset: null }
      : resolveWindow(query.window, this.clock());
    const persistedEvents = bundle.children
      .filter((item) => itemKind(item) === "event")
      .map((item) => item.publicData)
      .flatMap((value) => {
        const parsed = eventItemRuntimeSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
    const from = new Date(range.from).getTime();
    const to = new Date(range.to).getTime();
    const scopedEvents = persistedEvents.filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      const textMatch = !query.search || [event.summary, event.entity, event.source.name]
        .some((part) => part.toLocaleLowerCase("pt-BR").includes(query.search!.toLocaleLowerCase("pt-BR")));
      return timestamp >= from && timestamp <= to && textMatch
        && (!query.deviceType || event.dimensions.deviceType === query.deviceType)
        && (!query.region || event.dimensions.region === query.region)
        && (!query.appVersion || event.dimensions.appVersion === query.appVersion)
        && (!query.source || event.source.name === query.source);
    });
    const events = scopedEvents
      .filter((event) => !query.category || event.category === query.category)
      .sort((left, right) => query.sort === "oldest"
        ? left.timestamp.localeCompare(right.timestamp)
        : right.timestamp.localeCompare(left.timestamp));
    const categories = ["request", "vitals", "screen_view", "video_view", "session", "error"] as const;
    const categoryStats: EventsData["categoryStats"] = [
      { key: "all", name: "Todos", total: scopedEvents.length },
      ...categories.map((key) => ({
        key,
        name: key.replaceAll("_", " "),
        total: scopedEvents.filter((event) => event.category === key).length,
      })),
    ];
    const volume = new Map<string, number>();
    for (const event of events) {
      const timestamp = new Date(String(event.timestamp));
      if (Number.isNaN(timestamp.getTime())) continue;
      timestamp.setUTCMinutes(Math.floor(timestamp.getUTCMinutes() / 15) * 15, 0, 0);
      const bucket = timestamp.toISOString();
      volume.set(bucket, (volume.get(bucket) ?? 0) + 1);
    }
    const available = persistedEvents.length > 0;
    const fingerprintKey = fingerprint({ incidentId, ...query, cursor: undefined });
    const offset = query.cursor ? this.cursor.decode(query.cursor, fingerprintKey) : 0;
    const items = events.slice(offset, offset + query.limit);
    const hasMore = offset + items.length < events.length;
    const values = (pick: (event: EventData) => string | undefined) =>
      [...new Set(scopedEvents.map(pick).filter((value): value is string => Boolean(value)))].sort();
    const rawAvailable = persistedEvents.some((event) => event.raw.available);
    return {
      data: {
        incident: {
          id: incident.id,
          number: incident.number,
          title: incident.title,
        },
        capabilities: {
          aggregateMetrics: { status: available ? "available" : "unavailable" },
          filtering: {
            status: available ? "available" : "unavailable",
            supportedDimensions: ["category", "deviceType", "region", "appVersion", "source"],
            supportedFilterSets: Array.from({ length: 32 }, (_, mask) =>
              ["category", "deviceType", "region", "appVersion", "source"]
                .filter((_, index) => (mask & (1 << index)) !== 0)),
          },
          individualEvents: {
            status: available ? "available" : "unavailable",
            availableCategories: available ? categories : [],
            unavailableCategories: available ? [] : categories,
            reason: available ? null : "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED",
          },
          rawPayload: {
            status: rawAvailable ? "available" : "unavailable",
            reason: rawAvailable ? null : "RAW_PAYLOAD_NOT_STORED",
          },
        },
        categoryStats,
        volumeSeries: available ? {
          metric: "event_count",
          bucketSeconds: 900,
          points: [...volume].sort(([left], [right]) => left.localeCompare(right))
            .map(([timestamp, value]) => ({ timestamp, value })),
          anomalyWindows: [],
        } : null,
        items,
        facets: {
          categories: categoryStats,
          deviceTypes: values((event) => event.dimensions.deviceType),
          appVersions: values((event) => event.dimensions.appVersion),
          regions: values((event) => event.dimensions.region),
          sources: values((event) => event.source.name),
        },
        page: {
          limit: query.limit,
          hasMore,
          nextCursor: hasMore ? this.cursor.encode(offset + items.length, fingerprintKey) : null,
        },
      },
      quality: {
        window: range,
        partial: !available,
        refreshAfterSeconds: 900,
        freshness: [],
        warnings: available ? [] : [{
          code: "INDIVIDUAL_EVENTS_UNAVAILABLE",
          message: "Este incidente não possui eventos individuais persistidos.",
        }],
      },
    };
  }

  async event(incidentId: string, eventId: string): Promise<InternalResponse<EventData>> {
    const bundle = await this.repository.bundle(incidentId);
    if (!bundle.incident)
      throw new ServiceError(404, "RESOURCE_NOT_FOUND", "Incidente não encontrado.");
    const event = bundle.children
      .filter((item) => itemKind(item) === "event")
      .map((item) => eventItemRuntimeSchema.safeParse(item.publicData))
      .find((result) => result.success && result.data.id === eventId);
    if (!event?.success)
      throw new ServiceError(404, "RESOURCE_NOT_FOUND", "Evento não encontrado neste incidente.");
    return {
      data: event.data,
      quality: {
        window: null,
        partial: !event.data.raw.available,
        refreshAfterSeconds: null,
        freshness: [],
        warnings: event.data.raw.available ? [] : [{ code: "RAW_PAYLOAD_UNAVAILABLE", message: "O dado original deste evento não está armazenado." }],
      },
    };
  }

  async reanalyze(
    incidentId: string,
    idempotencyKey: string,
    requestedBy: string,
  ): Promise<void> {
    const bundle = await this.repository.bundle(incidentId);
    if (!bundle.incident)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidente não encontrado.",
      );
    const published = await this.reanalysis.publish({
      incidentId,
      idempotencyKey,
      requestedBy,
      reason: "MANUAL_REQUEST",
    });
    if (published === "unavailable")
      throw new ServiceError(
        503,
        "FEATURE_UNAVAILABLE",
        "A reanálise manual não está disponível.",
      );
  }

  async review(
    incidentId: string,
    selectedHypothesisId: string,
    body: ReviewBody,
    reviewerId: string,
  ): Promise<InternalResponse<ReviewData>> {
    const bundle = await this.repository.bundle(incidentId);
    if (!bundle.incident)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidente não encontrado.",
      );
    const hypotheses = bundle.children.filter(
      (item) => itemKind(item) === "hypothesis",
    );
    const hypothesis = hypotheses.find(
      (item) => hypothesisId(item) === selectedHypothesisId,
    );
    if (!hypothesis)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Hipótese não encontrada neste incidente.",
      );
    const currentVersion =
      typeof hypothesis.reviewVersion === "number"
        ? hypothesis.reviewVersion
        : typeof hypothesis.version === "number"
          ? hypothesis.version
          : 0;
    const currentStatus = hypothesis.reviewStatus;
    const currentNote =
      typeof hypothesis.reviewNote === "string" ? hypothesis.reviewNote : null;
    if (
      currentStatus === body.status &&
      currentNote === (body.note ?? null) &&
      currentVersion === body.expectedVersion + 1
    ) {
      return this.reviewResult(
        incidentId,
        selectedHypothesisId,
        body.status,
        currentNote,
        typeof hypothesis.reviewedAt === "string"
          ? hypothesis.reviewedAt
          : this.clock().toISOString(),
        currentVersion,
        false,
      );
    }
    if (currentVersion !== body.expectedVersion)
      throw new ServiceError(
        409,
        "REVIEW_VERSION_CONFLICT",
        "A hipótese foi revisada por outra sessão.",
        undefined,
        { currentVersion },
      );
    const key = { pk: hypothesis.pk, sk: hypothesis.sk };
    if (typeof key.pk !== "string" || typeof key.sk !== "string")
      throw new ServiceError(
        500,
        "INTERNAL_ERROR",
        "A hipótese persistida não possui chave válida.",
      );
    const reviewedAt = this.clock().toISOString();
    await this.repository.writeReview({
      key,
      expectedVersion: body.expectedVersion,
      status: body.status,
      note: body.note ?? null,
      reviewedAt,
      reviewerId,
    });
    const feedback = await this.feedback.publish({
      incidentId,
      hypothesisId: selectedHypothesisId,
      status: body.status,
    });
    return this.reviewResult(
      incidentId,
      selectedHypothesisId,
      body.status,
      body.note ?? null,
      reviewedAt,
      body.expectedVersion + 1,
      feedback === "unavailable",
    );
  }

  private reviewResult(
    incidentId: string,
    selectedHypothesisId: string,
    status: ReviewBody["status"],
    note: string | null,
    reviewedAt: string,
    version: number,
    feedbackUnavailable: boolean,
  ): InternalResponse<ReviewData> {
    return {
      data: {
        incidentId,
        hypothesisId: selectedHypothesisId,
        review: { status, note, reviewedAt, version },
      },
      quality: {
        window: null,
        partial: feedbackUnavailable,
        refreshAfterSeconds: null,
        freshness: [],
        warnings: feedbackUnavailable
          ? [
              {
                code: "REVIEW_FEEDBACK_DEFERRED",
                message:
                  "A revisão foi persistida; a integração futura de feedback está indisponível.",
              },
            ]
          : [],
      },
    };
  }
}

export class UnavailableReviewFeedbackPort implements ReviewFeedbackPort {
  async publish(): Promise<"unavailable"> {
    return "unavailable";
  }
}

export class UnavailableReanalysisPublisherPort implements ReanalysisPublisherPort {
  async publish(): Promise<"unavailable"> {
    return "unavailable";
  }
}

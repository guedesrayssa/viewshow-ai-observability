import {
  ServiceError,
  fingerprint,
  resolveWindow,
  type DiagnosisData,
  type EventsData,
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
    const measuredDevices = items
      .map((item) => item.impact.affectedDevices.value)
      .filter((value): value is number => value !== null);
    const measuredSessions = items
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
    for (const item of items) {
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
    limit: number,
  ): Promise<InternalResponse<EventsData>> {
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
    return {
      data: {
        incident: {
          id: incident.id,
          number: incident.number,
          title: incident.title,
        },
        capabilities: {
          aggregateMetrics: { status: "unavailable" },
          filtering: {
            status: "unavailable",
            supportedDimensions: [],
            supportedFilterSets: [[]],
          },
          individualEvents: {
            status: "unavailable",
            availableCategories: [],
            unavailableCategories: [
              "request",
              "vitals",
              "screen_view",
              "video_view",
              "session",
              "error",
            ],
            reason: "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED",
          },
          rawPayload: {
            status: "unavailable",
            reason: "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED",
          },
        },
        categoryStats: [],
        volumeSeries: null,
        items: [],
        facets: {
          categories: [],
          deviceTypes: [],
          appVersions: [],
          regions: [],
        },
        page: { limit, hasMore: false, nextCursor: null },
      },
      quality: {
        window: null,
        partial: true,
        refreshAfterSeconds: 900,
        freshness: [],
        warnings: [
          {
            code: "AGGREGATE_EVENTS_UNAVAILABLE",
            message:
              "O read model atual não contém agregados de eventos vinculados ao incidente.",
          },
          {
            code: "INDIVIDUAL_EVENTS_UNAVAILABLE",
            message:
              "Eventos individuais não possuem uma fonte configurada nesta fase.",
          },
        ],
      },
    };
  }

  event(): never {
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "A fonte de eventos individuais não está configurada.",
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

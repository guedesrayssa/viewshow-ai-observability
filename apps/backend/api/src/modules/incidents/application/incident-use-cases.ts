import { createHash } from "node:crypto";
import {
  ServiceError,
  assertNoPhysicalFields,
  diagnosisDataSchema,
  eventDtoSchema,
  eventsDataRuntimeSchema,
  incidentsDataSchema,
  resolveWindow,
  type DiagnosisData,
  type EventDto,
  type EventsData,
  type EventsQuery,
  type IncidentDto,
  type IncidentsData,
  type IncidentsQuery,
  type InternalResponse,
  type ReviewBody,
  type ReviewData,
  type ResolvedWindow,
} from "@view-show/contracts";
import { requireActiveDataset } from "../../datasets/application/require-active-dataset.js";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../../datasets/ports/active-dataset-resolver.js";
import type { CursorCodec } from "../domain/cursor.js";
import type {
  ActiveIncidentProjection,
  EventPagePosition,
  EventProjectionStatus,
  EventReadRequest,
  IncidentRepository,
  ReanalysisPublisherPort,
  ReviewFeedbackPort,
} from "../ports/incident-repository.js";

function ensureIncidentFiltersSupported(query: IncidentsQuery): void {
  if (query.cursor !== undefined)
    throw new ServiceError(
      400,
      "VALIDATION_ERROR",
      "O cursor informado não pertence ao contrato versionado atual.",
    );
  const unsupported = [
    "search",
    "deviceType",
    "os",
    "appVersion",
    "region",
    "state",
    "isp",
    "cdn",
    "content",
    "component",
    "eventType",
  ].filter((key) => query[key as keyof IncidentsQuery] !== undefined);
  if (query.sort === "impact") unsupported.push("sort");
  if (unsupported.length > 0)
    throw new ServiceError(
      422,
      "UNSUPPORTED_FILTER_COMBINATION",
      "A projeção atual não sustenta um ou mais seletores solicitados.",
    );
}

function dataUnavailable(message: string): never {
  throw new ServiceError(503, "DATA_UNAVAILABLE", message);
}

function featureUnavailable(message: string): never {
  throw new ServiceError(503, "FEATURE_UNAVAILABLE", message);
}

function requireProjectionVersion(
  active: ActiveDatasetSnapshot,
  family: "events" | "evidence",
): void {
  if (active.projectionVersions[family] !== "1.0")
    dataUnavailable(
      `A versão ativa ainda não contém uma projeção pública compatível de ${family}.`,
    );
}

const EVENT_DATASETS = [
  "signal_bucket",
  "live_event",
  "live_event_sde",
] as const;

function canonicalWindow(
  active: ActiveDatasetSnapshot,
  datasets: readonly string[],
): ResolvedWindow {
  const intervals = datasets.flatMap(
    (dataset) => active.availableIntervals[dataset] ?? [],
  );
  if (intervals.length === 0)
    dataUnavailable("O dataset ativo não informa o período disponível.");
  return {
    preset: "all",
    from: intervals.reduce(
      (earliest, interval) =>
        Date.parse(interval.start) < Date.parse(earliest)
          ? interval.start
          : earliest,
      intervals[0]!.start,
    ),
    to: intervals.reduce(
      (latest, interval) =>
        Date.parse(interval.end) > Date.parse(latest) ? interval.end : latest,
      intervals[0]!.end,
    ),
  };
}

function temporalWindow(
  query: {
    readonly window: "15m" | "30m" | "1h" | "6h" | "24h" | "all";
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
  active: ActiveDatasetSnapshot,
  datasets: readonly string[],
  now: Date,
): ResolvedWindow {
  if (query.from && query.to)
    return { preset: null, from: query.from, to: query.to };
  return query.window === "all"
    ? canonicalWindow(active, datasets)
    : resolveWindow(query.window, now);
}

function incidentState(value: string | null): IncidentDto["status"] {
  switch (value?.toLowerCase()) {
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

function incidentDto(
  incident: ActiveIncidentProjection["incidents"][number],
  observedThrough: string,
): IncidentDto {
  const measurement = {
    status: "unknown" as const,
    source: "argus:incidents",
    coverageRatio: null,
    observedThrough,
  };
  const measured = (unit: string) => ({ value: null, unit, measurement });
  return {
    id: incident.incidentId,
    number: incident.number,
    title: incident.number ?? `Incidente ${incident.incidentId.slice(-8)}`,
    priority: incident.priority,
    status: incidentState(incident.state),
    startedAt: incident.openedAt,
    detectedAt: null,
    endedAt: null,
    impact: {
      affectedDevices: measured("devices"),
      affectedSessions: measured("sessions"),
      shareOfObservedSessions: measured("percent"),
    },
    primaryComponent: null,
    scopeSummary: [],
    diagnosis: {
      status: "not_started",
      primaryHypothesisId: null,
      confidence: null,
      reviewStatus: "pending",
    },
  };
}

function cursorFingerprint(
  active: ActiveDatasetSnapshot,
  incidentId: string | null,
  query: EventsQuery,
  window: { from: string; to: string },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        datasetVersion: active.datasetVersion,
        incidentId,
        from: window.from,
        to: window.to,
        search: query.search ?? null,
        category: query.category ?? null,
        sourceDataset: query.sourceDataset ?? null,
        correlation: incidentId ? "linked" : query.correlation,
        sort: query.sort,
        limit: query.limit,
      }),
    )
    .digest("hex");
}

function eventPosition(
  value: unknown,
  incidentId: string | null,
): EventPagePosition {
  if (
    value === null ||
    typeof value !== "object" ||
    !("day" in value) ||
    typeof value.day !== "string" ||
    !(
      /^\d{8}$/.test(value.day) ||
      (incidentId !== null && value.day === "incident")
    ) ||
    !("sortKey" in value) ||
    typeof value.sortKey !== "string" ||
    !value.sortKey
  )
    throw new ServiceError(
      400,
      "VALIDATION_ERROR",
      "O cursor é inválido para estes filtros.",
    );
  return { day: value.day, sortKey: value.sortKey };
}

function eventQuality(
  status: EventProjectionStatus,
  to: string,
): InternalResponse<unknown>["quality"] {
  const lagSeconds = status.observedThrough
    ? Math.max(
        0,
        Math.round(
          (Date.parse(to) - Date.parse(status.observedThrough)) / 1000,
        ),
      )
    : null;
  const delayed = lagSeconds !== null && lagSeconds > 1800;
  const partial =
    status.coverage !== "complete" || status.qualityFlags.length > 0;
  return {
    window: null,
    partial,
    refreshAfterSeconds: 900,
    freshness: [
      {
        source: "argus:events",
        observedThrough: status.observedThrough,
        lagSeconds,
        state: delayed ? "delayed" : partial ? "partial" : "fresh",
      },
    ],
    warnings: status.qualityFlags.map((flag) => ({
      code: flag,
      message: flag,
    })),
  };
}

export class IncidentUseCases {
  constructor(
    private readonly repository: IncidentRepository,
    private readonly activeDataset: ActiveDatasetResolver,
    private readonly cursor: CursorCodec,
    _feedback: ReviewFeedbackPort,
    private readonly clock: () => Date = () => new Date(),
    _reanalysis: ReanalysisPublisherPort = new UnavailableReanalysisPublisherPort(),
  ) {}

  private async activeIncidents(
    active: ActiveDatasetSnapshot,
  ): Promise<ActiveIncidentProjection> {
    if (active.projectionVersions.incidents !== "1.0")
      return dataUnavailable(
        "A versão ativa ainda não contém uma projeção pública compatível de incidentes.",
      );
    const projection = await this.repository.activeProjection(active);
    if (!projection)
      return dataUnavailable(
        "A projeção de incidentes ainda não foi publicada pela ingestão.",
      );
    return projection;
  }

  private async requiredIncident(
    active: ActiveDatasetSnapshot,
    incidentId: string,
  ): Promise<{
    dto: IncidentDto;
    summary: { id: string; number: string | null; title: string };
  }> {
    const projection = await this.activeIncidents(active);
    const incident = projection.incidents.find(
      (item) => item.incidentId === incidentId,
    );
    if (!incident)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidente não encontrado.",
      );
    const dto = incidentDto(incident, projection.observedThrough);
    return {
      dto,
      summary: { id: dto.id, number: dto.number, title: dto.title },
    };
  }

  async list(query: IncidentsQuery): Promise<InternalResponse<IncidentsData>> {
    ensureIncidentFiltersSupported(query);
    const active = await requireActiveDataset(this.activeDataset);
    const projection = await this.activeIncidents(active);
    let incidents = projection.incidents.map((incident) =>
      incidentDto(incident, projection.observedThrough),
    );
    if (query.priority)
      incidents = incidents.filter((item) => item.priority === query.priority);
    if (query.status)
      incidents = incidents.filter((item) => item.status === query.status);
    incidents.sort((left, right) =>
      query.sort === "priority"
        ? left.priority.localeCompare(right.priority)
        : Date.parse(right.startedAt) - Date.parse(left.startedAt),
    );
    const hasMore = incidents.length > query.limit;
    const measurement = {
      status: "unknown" as const,
      source: "argus:incidents",
      coverageRatio: projection.coverage === "complete" ? 1 : null,
      observedThrough: projection.observedThrough,
    };
    const data = incidentsDataSchema.parse({
      capabilities: {
        filtering: {
          status: "partial",
          supportedDimensions: ["priority", "status"],
          supportedFilterSets: [
            ["priority"],
            ["status"],
            ["priority", "status"],
          ],
        },
      },
      items: incidents.slice(0, query.limit),
      impactSeries: {
        metric: query.chartMetric,
        unit: query.chartMetric === "affected_devices" ? "devices" : "sessions",
        bucketSeconds: 3600,
        measurement,
        points: [],
      },
      facets: {},
      page: { limit: query.limit, hasMore, nextCursor: null },
    });
    assertNoPhysicalFields(data);
    const window = temporalWindow(query, active, ["incidents"], this.clock());
    const lagSeconds = Math.max(
      0,
      Math.round(
        (Date.parse(window.to) - Date.parse(projection.observedThrough)) / 1000,
      ),
    );
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: {
        window,
        partial: true,
        refreshAfterSeconds: 900,
        freshness: [
          {
            source: "argus:incidents",
            observedThrough: projection.observedThrough,
            lagSeconds,
            state: lagSeconds > 1800 ? "delayed" : "partial",
          },
        ],
        warnings: [
          {
            code: "IMPACT_COUNTS_UNAVAILABLE",
            message:
              "A projeção de incidentes ainda não contém contagens de impacto.",
          },
        ],
      },
    };
  }

  private async readEvents(
    incidentId: string | null,
    query: EventsQuery,
  ): Promise<InternalResponse<EventsData>> {
    const active = await requireActiveDataset(this.activeDataset);
    requireProjectionVersion(active, "events");
    const status = await this.repository.eventProjection(active);
    if (!status)
      return dataUnavailable(
        "A projeção de Eventos ainda não foi publicada pela ingestão.",
      );
    const incident = incidentId
      ? (await this.requiredIncident(active, incidentId)).summary
      : null;
    const window = temporalWindow(query, active, EVENT_DATASETS, this.clock());
    const fingerprint = cursorFingerprint(active, incidentId, query, window);
    const position = query.cursor
      ? eventPosition(
          this.cursor.decodeState(query.cursor, fingerprint),
          incidentId,
        )
      : null;
    const request: EventReadRequest = {
      incidentId,
      from: window.from,
      to: window.to,
      ...(query.search ? { search: query.search } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.sourceDataset ? { sourceDataset: query.sourceDataset } : {}),
      correlation: incidentId ? "linked" : query.correlation,
      sort: query.sort,
      limit: query.limit,
      position,
    };
    const page = await this.repository.listEvents(active, request);
    const data = eventsDataRuntimeSchema.parse({
      incident,
      capabilities: {
        filtering: {
          status: "available",
          supportedDimensions: ["category", "sourceDataset", "correlation"],
          supportedFilterSets: [["category", "sourceDataset", "correlation"]],
        },
      },
      categoryStats: page.categoryStats,
      volumeSeries: null,
      items: page.items,
      facets: page.facets,
      page: {
        limit: query.limit,
        hasMore: page.next !== null,
        nextCursor: page.next
          ? this.cursor.encodeState(page.next, fingerprint)
          : null,
      },
    });
    assertNoPhysicalFields(data);
    const quality = eventQuality(status, window.to);
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: { ...quality, window },
    };
  }

  async globalEvents(
    query: EventsQuery,
  ): Promise<InternalResponse<EventsData>> {
    return this.readEvents(null, query);
  }

  async events(
    incidentId: string,
    query: EventsQuery,
  ): Promise<InternalResponse<EventsData>> {
    return this.readEvents(incidentId, query);
  }

  private async readEvent(
    incidentId: string | null,
    eventId: string,
  ): Promise<InternalResponse<EventDto>> {
    const active = await requireActiveDataset(this.activeDataset);
    requireProjectionVersion(active, "events");
    const status = await this.repository.eventProjection(active);
    if (!status)
      return dataUnavailable(
        "A projeção de Eventos ainda não foi publicada pela ingestão.",
      );
    if (incidentId) await this.requiredIncident(active, incidentId);
    const event = await this.repository.getEvent(active, eventId, incidentId);
    if (!event)
      throw new ServiceError(
        404,
        "RESOURCE_NOT_FOUND",
        "Evento não encontrado.",
      );
    const data = eventDtoSchema.parse(event);
    assertNoPhysicalFields(data);
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: eventQuality(status, this.clock().toISOString()),
    };
  }

  async globalEvent(eventId: string): Promise<InternalResponse<EventDto>> {
    return this.readEvent(null, eventId);
  }

  async event(
    incidentId: string,
    eventId: string,
  ): Promise<InternalResponse<EventDto>> {
    return this.readEvent(incidentId, eventId);
  }

  async diagnosis(
    incidentId: string,
  ): Promise<InternalResponse<DiagnosisData>> {
    const active = await requireActiveDataset(this.activeDataset);
    requireProjectionVersion(active, "evidence");
    const status = await this.repository.eventProjection(active);
    if (!status)
      return dataUnavailable(
        "A projeção de Evidências ainda não foi publicada pela ingestão.",
      );
    const incident = (await this.requiredIncident(active, incidentId)).dto;
    const evidence = await this.repository.listEvidence(active, incidentId);
    const data = diagnosisDataSchema.parse({
      incident,
      diagnosis: {
        status: "not_started",
        generatedAt: null,
        summary: null,
        primaryHypothesisId: null,
        confidence: null,
        hypotheses: [],
      },
      evidence,
      charts: { buffering: null, concentrations: [], concentrationNote: "" },
      timeline: [],
      changes: [],
      dataQuality: {
        status: evidence.length > 0 ? "sufficient" : "limited",
        coverageRatio: status.coverage === "complete" ? 1 : null,
        observedThrough: status.observedThrough,
        gaps: status.qualityFlags,
      },
    }) as DiagnosisData;
    assertNoPhysicalFields(data);
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: eventQuality(status, this.clock().toISOString()),
    };
  }

  async reanalyze(
    _incidentId: string,
    _idempotencyKey: string,
    _requestedBy: string,
  ): Promise<void> {
    await requireActiveDataset(this.activeDataset);
    return featureUnavailable(
      "A reanálise manual não está disponível para o contrato físico ativo.",
    );
  }

  async review(
    _incidentId: string,
    _selectedHypothesisId: string,
    _body: ReviewBody,
    _reviewerId: string,
  ): Promise<InternalResponse<ReviewData>> {
    await requireActiveDataset(this.activeDataset);
    return featureUnavailable(
      "A revisão de hipóteses não está disponível para o contrato físico ativo.",
    );
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

import {
  ServiceError,
  assertNoPhysicalFields,
  monitoringProjectionSchema,
  resolveWindow,
  type InternalResponse,
  type Warning,
} from "@view-show/contracts";
import type {
  DashboardReadRepository,
  ProjectionRead,
  PublicProjection,
} from "../ports/dashboard-read-repository.js";

type OverviewQuery = {
  readonly window: "15m" | "30m" | "1h" | "6h" | "24h";
  readonly search?: string | undefined;
  readonly deviceType?: string | undefined;
  readonly region?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly incidentLimit?: number | undefined;
};
type MonitoringQuery = {
  readonly window: "15m" | "30m" | "1h" | "6h";
  readonly source?: string | undefined;
  readonly worker?: string | undefined;
  readonly flowMetric: "ingestion_rate" | "processing_latency" | "queue_depth";
};

function quality(
  read: ProjectionRead,
  window: ReturnType<typeof resolveWindow>,
  warnings: readonly Warning[],
): InternalResponse<PublicProjection>["quality"] {
  const observed = read.observedThrough ? new Date(read.observedThrough) : null;
  const lagSeconds =
    observed && !Number.isNaN(observed.getTime())
      ? Math.max(
          0,
          Math.round(
            (new Date(window.to).getTime() - observed.getTime()) / 1000,
          ),
        )
      : null;
  const stale = observed !== null && !Number.isNaN(observed.getTime()) && observed < new Date(window.from);
  const qualityWarnings = stale
    ? [{ code: "STALE_SNAPSHOT", message: "O último snapshot disponível é anterior à janela solicitada; os valores podem estar desatualizados." }, ...warnings]
    : warnings;
  return {
    window,
    partial:
      qualityWarnings.length > 0 ||
      (read.coverageRatio !== null && read.coverageRatio < 1),
    refreshAfterSeconds: 900,
    freshness: [
      {
        source: read.source,
        observedThrough: read.observedThrough,
        lagSeconds,
        state:
          lagSeconds === null
            ? "partial"
            : stale || lagSeconds > 1800
              ? "delayed"
              : "fresh",
      },
    ],
    warnings: qualityWarnings,
  };
}

export class DashboardQueries {
  constructor(
    private readonly repository: DashboardReadRepository,
    private readonly monitoringSources: readonly string[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async overview(
    query: OverviewQuery,
  ): Promise<InternalResponse<PublicProjection>> {
    const unsupportedFilters = [
      query.search ? "search" : null,
      query.deviceType ? "deviceType" : null,
      query.region ? "region" : null,
      query.appVersion ? "appVersion" : null,
    ].filter(Boolean);
    if (unsupportedFilters.length > 0)
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "A projeção atual não sustenta os filtros solicitados.",
      );
    const window = resolveWindow(query.window, this.clock());
    const read = await this.repository.latestOverview(
      new Date(window.from),
      new Date(window.to),
    );
    if (!read)
      throw new ServiceError(
        503,
        "DATA_UNAVAILABLE",
        "A projeção de visão geral ainda não foi publicada pela ingestão.",
      );
    const recentIncidents = read.data.recentIncidents;
    const data =
      Array.isArray(recentIncidents) && query.incidentLimit !== undefined
        ? {
            ...read.data,
            recentIncidents: recentIncidents.slice(0, query.incidentLimit),
          }
        : read.data;
    assertNoPhysicalFields(data);
    return { data, quality: quality(read, window, []) };
  }

  async monitoring(
    query: MonitoringQuery,
  ): Promise<InternalResponse<PublicProjection>> {
    if (query.flowMetric === "queue_depth")
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "O pipeline batch atual não possui fila.",
      );
    const window = resolveWindow(query.window, this.clock());
    const sources = query.source
      ? query.source
          .split(",")
          .map((source) => source.trim())
          .filter(Boolean)
      : this.monitoringSources;
    const read = await this.repository.latestMonitoring(
      new Date(window.from),
      new Date(window.to),
      sources,
    );
    if (!read)
      throw new ServiceError(
        503,
        "DATA_UNAVAILABLE",
        "A projeção de monitoramento ainda não foi publicada pela ingestão.",
      );
    const projection = monitoringProjectionSchema.safeParse(read.data);
    if (!projection.success)
      throw new ServiceError(503, "DATA_UNAVAILABLE", "A projeção de monitoramento publicada não segue o contrato esperado.");
    assertNoPhysicalFields(projection.data);
    const warnings = [
      {
        code: "QUEUELESS_BATCH_PIPELINE",
        message: "Fila e DLQ não se aplicam ao pipeline batch atual.",
      },
    ];
    return { data: projection.data, quality: quality(read, window, warnings) };
  }
}

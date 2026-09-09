import {
  ServiceError,
  assertNoPhysicalFields,
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
  readonly deviceType?: string | undefined;
  readonly region?: string | undefined;
  readonly appVersion?: string | undefined;
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
  return {
    window,
    partial:
      warnings.length > 0 ||
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
            : lagSeconds > 1800
              ? "delayed"
              : "fresh",
      },
    ],
    warnings,
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
    const dimensions = [
      query.deviceType ? "deviceType" : null,
      query.region ? "region" : null,
      query.appVersion ? "appVersion" : null,
    ].filter(Boolean);
    if (dimensions.length > 1)
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "A origem atual não permite combinar estes filtros.",
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
    assertNoPhysicalFields(read.data);
    return { data: read.data, quality: quality(read, window, []) };
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
    assertNoPhysicalFields(read.data);
    const warnings = [
      {
        code: "QUEUELESS_BATCH_PIPELINE",
        message: "Fila e DLQ não se aplicam ao pipeline batch atual.",
      },
    ];
    return { data: read.data, quality: quality(read, window, warnings) };
  }
}

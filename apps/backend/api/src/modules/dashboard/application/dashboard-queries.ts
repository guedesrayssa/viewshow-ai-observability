import {
  ServiceError,
  assertNoPhysicalFields,
  monitoringProjectionSchema,
  resolveWindow,
  type InternalResponse,
  type Warning,
} from "@view-show/contracts";
import { requireActiveDataset } from "../../datasets/application/require-active-dataset.js";
import type { ActiveDatasetResolver } from "../../datasets/ports/active-dataset-resolver.js";
import type {
  DashboardReadRepository,
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

function dataUnavailable(message: string): never {
  throw new ServiceError(503, "DATA_UNAVAILABLE", message);
}

function quality(
  read: import("../ports/dashboard-read-repository.js").ProjectionRead,
  window: ReturnType<typeof resolveWindow>,
  warnings: readonly Warning[],
): InternalResponse<PublicProjection>["quality"] {
  const observed = read.observedThrough ? new Date(read.observedThrough) : null;
  const lagSeconds =
    observed && !Number.isNaN(observed.getTime())
      ? Math.max(
          0,
          Math.round((Date.parse(window.to) - observed.getTime()) / 1000),
        )
      : null;
  const stale =
    observed !== null &&
    !Number.isNaN(observed.getTime()) &&
    observed < new Date(window.from);
  const qualityWarnings = stale
    ? [
        {
          code: "STALE_SNAPSHOT",
          message:
            "O último snapshot disponível é anterior à janela solicitada; os valores podem estar desatualizados.",
        },
        ...warnings,
      ]
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
    private readonly activeDataset: ActiveDatasetResolver,
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
    if (unsupportedFilters.length > 0) {
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "A projeção atual não sustenta os filtros solicitados.",
      );
    }

    const active = await requireActiveDataset(this.activeDataset);
    if (active.projectionVersions.overview !== "1.0")
      return dataUnavailable(
        "A versão ativa ainda não contém uma projeção pública compatível para a visão geral.",
      );
    const read = await this.repository.activeOverview(active);
    if (!read)
      return dataUnavailable(
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
    const window = resolveWindow(query.window, this.clock());
    const warnings: Warning[] = [];
    if (
      read.observedThrough &&
      Date.parse(read.observedThrough) < Date.parse(window.from)
    ) {
      warnings.push({
        code: "ACTIVE_SNAPSHOT_OUTSIDE_WINDOW",
        message:
          "O dataset ativo é anterior à janela selecionada; exibindo a medição mais recente importada.",
      });
    }
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: quality(read, window, warnings),
    };
  }

  async monitoring(
    query: MonitoringQuery,
  ): Promise<InternalResponse<PublicProjection>> {
    if (query.worker || query.flowMetric === "queue_depth") {
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "A projeção atual não sustenta o seletor de monitoramento solicitado.",
      );
    }

    const active = await requireActiveDataset(this.activeDataset);
    if (active.projectionVersions.monitoring !== "1.0")
      return dataUnavailable(
        "A versão ativa ainda não contém uma projeção pública compatível para o monitoramento.",
      );
    if (
      query.source !== undefined &&
      !this.monitoringSources.includes(query.source)
    )
      throw new ServiceError(
        422,
        "UNSUPPORTED_FILTER_COMBINATION",
        "A fonte solicitada não está habilitada para monitoramento.",
      );
    const window = resolveWindow(query.window, this.clock());
    const sources = query.source ? [query.source] : this.monitoringSources;
    const read = await this.repository.latestMonitoring(
      active,
      new Date(window.from),
      new Date(window.to),
      sources,
    );
    if (!read)
      return dataUnavailable(
        "A projeção de monitoramento ainda não foi publicada pela ingestão.",
      );
    const parsed = monitoringProjectionSchema.parse(read.data);
    const data =
      query.flowMetric === "ingestion_rate"
        ? monitoringProjectionSchema.parse({
            ...parsed,
            flow: {
              metric: "ingestion_rate",
              unit: parsed.kpis.ingestionRate.unit,
              bucketSeconds: parsed.flow.bucketSeconds,
              measurement: parsed.kpis.ingestionRate.measurement,
              target: null,
              series:
                parsed.kpis.ingestionRate.value === null ||
                parsed.kpis.ingestionRate.measurement.observedThrough === null
                  ? []
                  : [
                      {
                        stage: "ingestion",
                        name: "Ingestão",
                        points: [
                          {
                            timestamp:
                              parsed.kpis.ingestionRate.measurement
                                .observedThrough,
                            value: parsed.kpis.ingestionRate.value,
                          },
                        ],
                      },
                    ],
              peak:
                parsed.kpis.ingestionRate.value === null ||
                parsed.kpis.ingestionRate.measurement.observedThrough === null
                  ? null
                  : {
                      timestamp:
                        parsed.kpis.ingestionRate.measurement.observedThrough,
                      stage: "ingestion",
                      value: parsed.kpis.ingestionRate.value,
                    },
            },
          })
        : parsed;
    assertNoPhysicalFields(data);
    const warnings: Warning[] = [];
    const reason = data.capabilities.pipelineRuntime.reason;
    if (reason)
      warnings.push({
        code: reason,
        message:
          "A origem ainda não publicou as métricas da fila e da DLQ de análise.",
      });
    return {
      data,
      datasetVersion: active.datasetVersion,
      quality: quality(read, window, warnings),
    };
  }
}

/**
 * @file overview-resource.ts
 * Série de "saúde da experiência" da Visão Geral.
 *
 * Esta leitura cobre só o gráfico de travamento no tempo, que é medição de QoE
 * e vem da API de telemetria. Os três indicadores do topo e a lista de
 * incidentes recentes saem da API operacional e vivem em `summary-resource.ts`.
 *
 * A telemetria é dependência dura aqui: sem ela, o gráfico declara
 * indisponibilidade. O resto da tela continua com dado real, porque não
 * depende desta leitura.
 */

import {
  apiGet,
  composeResource,
  jitter,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { WARNINGS } from "@/lib/data/warnings";
import {
  EXPERIENCE_HEALTH_ANOMALY_RANGE,
  EXPERIENCE_HEALTH_BASELINE,
  EXPERIENCE_HEALTH_PEAK_INDEX,
  EXPERIENCE_HEALTH_SERIES,
  type ExperiencePoint,
} from "@/lib/dashboard-data";

/** Recorte pedido pela barra de filtros. */
export type OverviewFilters = {
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

/** O que o cartão "Saúde da experiência" desenha em uma leitura. */
export type OverviewData = {
  series: ExperiencePoint[];
  /** `null` enquanto não houver linha de base publicada. */
  baseline: number | null;
  /** `null` enquanto não houver detecção de anomalia na origem. */
  anomalyRange: [number, number] | null;
  peakIndex: number;
};

/* -------------------------------------------------------------------------
 * Formato da resposta de telemetria, como a API a publica hoje.
 * ---------------------------------------------------------------------- */

/** Bloco de métricas de QoE, repetido em cada ponto da série. */
export type QoeMetricsBlock = {
  rebuffer: { rate: number | null; count: number };
};

/** `GET /v1/analytics/qoe/timeseries`. */
export type QoeTimeseriesResponse = {
  interval_seconds: number;
  points: { start: string; end: string; metrics: QoeMetricsBlock }[];
};

/** Rótulo do eixo a partir do início do intervalo, no fuso de quem lê. */
function toClockLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Escreve a taxa de travamento como percentual, com duas casas. */
export function formatRebufferRate(value: number): string {
  return `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

/** Índice do maior ponto da série. Zero quando a série está vazia. */
function peakOf(series: ExperiencePoint[]): number {
  return series.reduce(
    (best, point, index, all) => (point.value > all[best].value ? index : best),
    0,
  );
}

/** Conjunto de exemplo, com leve variação a cada atualização. */
function exampleOverview(revision: number): OverviewData {
  return {
    series: EXPERIENCE_HEALTH_SERIES.map((point, index) => ({
      ...point,
      value:
        revision === 0
          ? point.value
          : Math.round(jitter(point.value, revision * 100 + index, 0.08)),
    })),
    baseline: EXPERIENCE_HEALTH_BASELINE,
    anomalyRange: EXPERIENCE_HEALTH_ANOMALY_RANGE,
    peakIndex: EXPERIENCE_HEALTH_PEAK_INDEX,
  };
}

/**
 * Lê a série de travamento para o recorte selecionado.
 *
 * @param filters - Recorte da barra de filtros; só o período é enviado.
 * @param revision - Número da leitura, usado só pelo conjunto de exemplo.
 *
 * @example
 * const overview = useResource((revision) => fetchOverview(filters, revision), [filters.timeRange]);
 */
export function fetchOverview(
  filters: OverviewFilters,
  revision = 0,
): Promise<Resource<OverviewData>> {
  const window = filters.timeRange;

  return composeResource<OverviewData>({
    targets: ["telemetria"],
    // A linha de base e a detecção de anomalia não existem em nenhuma das duas
    // APIs. Declarar isso é o que permite ao gráfico não desenhar uma
    // referência que ninguém publicou.
    warnings: [WARNINGS.semLinhaDeBase],
    read: async () => {
      const timeseries = await apiGet<QoeTimeseriesResponse>(
        "telemetria",
        ENDPOINTS.telemetria.qoeTimeseries,
        { window },
      );

      const series: ExperiencePoint[] = timeseries.points.map((point) => ({
        label: toClockLabel(point.start),
        value: point.metrics.rebuffer.rate ?? 0,
      }));

      return {
        series,
        baseline: null,
        anomalyRange: null,
        peakIndex: peakOf(series),
      };
    },
    fallback: () => exampleOverview(revision),
  });
}

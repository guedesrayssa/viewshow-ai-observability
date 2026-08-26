/**
 * @file overview-resource.ts
 * Leitura dos dados da Visão Geral.
 *
 * É o ponto de integração da tela com a API de telemetria: cada bloco declara
 * o endpoint que vai servi-lo, como converter a resposta e o que mostrar
 * enquanto a API não responde. Ligar o backend é preencher os `map` com o
 * formato real das rotas de `lib/data/endpoints.ts`.
 */

import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import {
  EXPERIENCE_HEALTH_SERIES,
  INCIDENTS,
  STATS,
  type ExperiencePoint,
  type IncidentData,
  type StatCardData,
} from "@/lib/dashboard-data";

/** Recorte pedido pela barra de filtros. */
export type OverviewFilters = {
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

/** Tudo o que a Visão Geral desenha em uma leitura. */
export type OverviewData = {
  stats: StatCardData[];
  series: ExperiencePoint[];
  baseline: number;
  anomalyRange: [number, number];
  peakIndex: number;
  incidents: IncidentData[];
};

/**
 * Resposta esperada da API para o resumo em tempo real.
 *
 * Declarada aqui para que o formato do backend fique explícito no lugar onde
 * ele vai ser consumido. A conversão para `OverviewData` acontece no `map`.
 */
export type RealtimeOverviewResponse = {
  error_rate_per_minute: number;
  latency_p95_ms: number;
  affected_sessions: number;
  series: { label: string; value: number }[];
};

/** Conjunto de exemplo, com leve variação a cada atualização. */
function exampleOverview(revision: number): OverviewData {
  return {
    stats: STATS.map((stat, index) => ({
      ...stat,
      value:
        revision === 0
          ? stat.value
          : Math.round(jitter(stat.value, revision * 10 + index, 0.05)),
    })),
    series: EXPERIENCE_HEALTH_SERIES.map((point, index) => ({
      ...point,
      value:
        revision === 0
          ? point.value
          : Math.round(jitter(point.value, revision * 100 + index, 0.08)),
    })),
    baseline: 100,
    anomalyRange: [6, 8],
    peakIndex: 7,
    incidents: INCIDENTS,
  };
}

/**
 * Lê o estado do ecossistema para o recorte selecionado.
 *
 * @param filters - Recorte da barra de filtros.
 * @param revision - Número da leitura, usado só pelo conjunto de exemplo.
 *
 * @example
 * const overview = useResource((revision) => fetchOverview(filters, revision), [filters]);
 */
export function fetchOverview(
  filters: OverviewFilters,
  revision = 0,
): Promise<Resource<OverviewData>> {
  return loadResource<RealtimeOverviewResponse, OverviewData>({
    path: ENDPOINTS.realtimeOverview,
    params: {
      window: filters.timeRange,
      device: filters.device,
      region: filters.region,
      app_version: filters.appVersion,
    },
    map: (response) => ({
      stats: [
        { ...STATS[0], value: response.error_rate_per_minute },
        { ...STATS[1], value: response.latency_p95_ms },
        { ...STATS[2], value: response.affected_sessions },
      ],
      series: response.series,
      baseline: 100,
      anomalyRange: [6, 8],
      peakIndex: response.series.reduce(
        (best, point, index, all) =>
          point.value > all[best].value ? index : best,
        0,
      ),
      incidents: INCIDENTS,
    }),
    fallback: () => exampleOverview(revision),
  });
}

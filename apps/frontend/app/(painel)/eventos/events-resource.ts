/**
 * @file events-resource.ts
 * Leitura dos dados da tela de Eventos.
 *
 * Os eventos correlacionados virão da consulta de eventos da API, e o volume
 * temporal, da série de erros do mesmo recorte. Enquanto a integração não
 * existe, as duas leituras caem no conjunto de exemplo do INC-4821.
 */

import {
  CATEGORY_STATS,
  EVENTS,
  VOLUME_DATASETS,
  type CategoryStat,
  type CorrelatedEvent,
  type VolumePeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/eventos/events-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

/** Recorte pedido pelos filtros da tela. */
export type EventsQuery = {
  period: string;
  category: string;
  deviceType: string;
  region: string;
  appVersion: string;
  source: string;
};

/** Eventos e contagens por tipo de uma leitura. */
export type EventsData = {
  events: CorrelatedEvent[];
  /** Totais das abas por tipo, no recorte lido. */
  categories: CategoryStat[];
};

/** Resposta esperada da API para os eventos correlacionados. */
export type EventsResponse = {
  events: CorrelatedEvent[];
  category_totals: CategoryStat[];
};

/** Resposta esperada da API para o volume por minuto. */
export type VolumeResponse = {
  times: string[];
  values: number[];
};

/** Converte "todos" em ausência de filtro, como a API espera. */
function optional(value: string): string | undefined {
  return value === "all" ? undefined : value;
}

/**
 * Lê os eventos correlacionados ao recorte.
 *
 * @example
 * const events = useResource(() => fetchEvents(query), [query]);
 */
export function fetchEvents(query: EventsQuery): Promise<Resource<EventsData>> {
  return loadResource<EventsResponse, EventsData>({
    path: ENDPOINTS.rcaFingerprints,
    params: {
      window: optional(query.period) ? `${query.period}m` : undefined,
      category: optional(query.category),
      device: optional(query.deviceType),
      region: optional(query.region),
      app_version: optional(query.appVersion),
      source: optional(query.source),
    },
    map: (response) => ({
      events: response.events,
      categories: response.category_totals,
    }),
    // A lista de exemplo é estável: são registros identificados, e mexer nos
    // valores deles daria a impressão de eventos diferentes a cada leitura.
    fallback: () => ({ events: EVENTS, categories: CATEGORY_STATS }),
  });
}

/**
 * Lê o volume temporal de eventos da janela selecionada.
 *
 * @param period - Janela do gráfico de volume.
 */
export function fetchEventVolume(
  period: VolumePeriodKey,
  revision = 0,
): Promise<Resource<VolumeSeries>> {
  return loadResource<VolumeResponse, VolumeSeries>({
    path: ENDPOINTS.qoeTimeseries,
    params: { window: `${period}m`, metric: "events_per_minute" },
    map: (response) => ({
      ...VOLUME_DATASETS[period],
      times: response.times,
      values: response.values,
      peakIndex: response.values.reduce(
        (best, value, index, all) => (value > all[best] ? index : best),
        0,
      ),
    }),
    fallback: () => {
      const series = VOLUME_DATASETS[period];

      return {
        ...series,
        values:
          revision === 0
            ? series.values
            : series.values.map((value, index) =>
                Math.round(jitter(value, revision * 60 + index, 0.08)),
              ),
      };
    },
  });
}

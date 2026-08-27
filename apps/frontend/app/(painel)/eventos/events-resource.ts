/**
 * @file events-resource.ts
 * Leitura dos dados da tela de Eventos.
 *
 * O único número real desta tela é o volume por intervalo, que vem da série de
 * QoE da API de telemetria: cada ponto traz a contagem de eventos do bucket.
 *
 * A lista de eventos individuais não tem fonte. Nenhuma das duas APIs expõe as
 * seis categorias, e a auditoria do contrato registrou que os agregados da
 * origem não reconstroem um evento individual — não há como derivá-los sem
 * inventar. Em ambiente com exemplo permitido, a tabela mostra o conjunto de
 * demonstração com o selo dizendo isso; em produção, a leitura declara
 * indisponibilidade e a tela desenha o estado vazio com o motivo.
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
import {
  composeResource,
  jitter,
  loadResource,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { WARNINGS } from "@/lib/data/warnings";

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

/** Série de QoE da API de telemetria; só a contagem de eventos interessa aqui. */
export type QoeTimeseriesResponse = {
  interval_seconds: number;
  points: { start: string; metrics: { events: number } }[];
};

/** Rótulo do eixo a partir do início do intervalo, no fuso de quem lê. */
function toClockLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Marcas redondas do eixo: zero, o teto e o meio. */
function axisFor(values: number[]): { axisMax: number; axisTicks: number[] } {
  const top = Math.max(...values, 1);
  const magnitude = 10 ** Math.floor(Math.log10(top));
  const axisMax = Math.ceil(top / magnitude) * magnitude;
  return { axisMax, axisTicks: [0, axisMax / 2, axisMax] };
}

/**
 * Lê os eventos correlacionados ao recorte.
 *
 * Não há fonte de eventos individuais nesta fase, e a leitura diz isso em vez
 * de consultar uma rota que não existe.
 *
 * @example
 * const events = useResource(() => fetchEvents(query), [query]);
 */
export function fetchEvents(query: EventsQuery): Promise<Resource<EventsData>> {
  void query;

  return composeResource<EventsData>({
    targets: ["telemetria"],
    warnings: [WARNINGS.eventosIndividuais],
    read: async () => ({ events: [], categories: [] }),
    // A lista de exemplo é estável: são registros identificados, e mexer nos
    // valores deles daria a impressão de eventos diferentes a cada leitura.
    fallback: () => ({ events: EVENTS, categories: CATEGORY_STATS }),
  });
}

/**
 * Lê o volume temporal de eventos da janela selecionada.
 *
 * @param period - Janela do gráfico de volume, em minutos.
 */
export function fetchEventVolume(
  period: VolumePeriodKey,
  revision = 0,
): Promise<Resource<VolumeSeries>> {
  return loadResource<QoeTimeseriesResponse, VolumeSeries>({
    target: "telemetria",
    path: ENDPOINTS.telemetria.qoeTimeseries,
    params: { window: `${period}m` },
    map: (response) => {
      const values = response.points.map((point) => point.metrics.events);

      return {
        times: response.points.map((point) => toClockLabel(point.start)),
        values,
        peakIndex: values.reduce(
          (best, value, index, all) => (value > all[best] ? index : best),
          0,
        ),
        // A origem não detecta anomalia: sem janela destacada.
        anomalyRange: null,
        ...axisFor(values),
      };
    },
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

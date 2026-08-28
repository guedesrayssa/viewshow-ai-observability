/**
 * @file telemetry-data.ts
 * Dados de exemplo e derivações da tela de Monitoramento.
 *
 * Concentra tudo o que a tela mostra sobre o pipeline de telemetria: as
 * fontes, as séries do fluxo de processamento e a concentração geográfica.
 * Os cartões de KPI, o gráfico e a tabela são todos derivados das fontes
 * selecionadas, de modo que os filtros da seção 5.6 do entendimento de UX
 * (fonte, métrica, worker e janela) mudam de fato o que a tela apresenta.
 *
 * Enquanto a integração com a telemetria não existe, os números reproduzem
 * o protótipo de alta fidelidade: 2,8 mi/min de ingestão, 48 s de latência,
 * 18,4 mil mensagens na fila e 23 na DLQ, com 7 novas em 15 minutos.
 */

import {
  STATE_SHAPES,
  type StateShape,
} from "@/app/(painel)/monitoramento/br-states-geometry";

export { MAP_VIEW_BOX } from "@/app/(painel)/monitoramento/br-states-geometry";
export type { StateShape };

/** Janela de comparação usada nos cartões de KPI. */
export type WindowKey = "15" | "30" | "60" | "360";

export const WINDOW_LABELS: Record<WindowKey, string> = {
  "15": "15 min",
  "30": "30 min",
  "60": "1 hora",
  "360": "6 horas",
};

/** Estado de saúde de uma fonte de telemetria. */
export type SourceState = "estavel" | "atrasado" | "parcial";

export type TelemetrySource = {
  id: string;
  name: string;
  worker: string;
  /** Segundos desde o último lote recebido da fonte. */
  updatedSecondsAgo: number;
  /** Percentual dos eventos esperados que chegaram íntegros. */
  coverage: number;
  state: SourceState;
  /** Milhões de eventos por minuto. */
  ingestionPerMinute: number;
  /** Segundos entre a coleta e a disponibilização do evento. */
  processingLatency: number;
  /** Milhares de mensagens aguardando processamento. */
  queueDepth: number;
  /** Mensagens acumuladas na fila de falhas. */
  deadLetters: number;
  /** Mensagens que entraram na fila de falhas em cada janela. */
  newDeadLetters: Record<WindowKey, number>;
  /** Variação percentual da ingestão em cada janela. */
  ingestionTrend: Record<WindowKey, number>;
  /** Variação percentual da profundidade da fila em cada janela. */
  queueTrend: Record<WindowKey, number>;
};

export const SOURCES: TelemetrySource[] = [
  {
    id: "player",
    name: "Player",
    worker: "worker-01",
    updatedSecondsAgo: 18,
    coverage: 100,
    state: "estavel",
    ingestionPerMinute: 1.2,
    processingLatency: 40,
    queueDepth: 6.2,
    deadLetters: 4,
    newDeadLetters: { "15": 1, "30": 2, "60": 3, "360": 9 },
    ingestionTrend: { "15": 3, "30": 5, "60": 2, "360": -1 },
    queueTrend: { "15": 6, "30": 9, "60": 4, "360": -3 },
  },
  {
    id: "youbora",
    name: "Youbora",
    worker: "worker-02",
    updatedSecondsAgo: 272,
    coverage: 97,
    state: "atrasado",
    ingestionPerMinute: 0.9,
    processingLatency: 62,
    queueDepth: 7.8,
    deadLetters: 12,
    newDeadLetters: { "15": 4, "30": 7, "60": 11, "360": 38 },
    ingestionTrend: { "15": 6, "30": 9, "60": 4, "360": 2 },
    queueTrend: { "15": 23, "30": 34, "60": 41, "360": 52 },
  },
  {
    id: "prometheus",
    name: "Prometheus",
    worker: "worker-03",
    updatedSecondsAgo: 51,
    coverage: 82,
    state: "parcial",
    ingestionPerMinute: 0.4,
    processingLatency: 52,
    queueDepth: 3.1,
    deadLetters: 5,
    newDeadLetters: { "15": 1, "30": 2, "60": 4, "360": 12 },
    ingestionTrend: { "15": 2, "30": 3, "60": 1, "360": -2 },
    queueTrend: { "15": 9, "30": 12, "60": 15, "360": 18 },
  },
  {
    id: "apollo",
    name: "Apollo",
    worker: "worker-01",
    updatedSecondsAgo: 36,
    coverage: 100,
    state: "estavel",
    ingestionPerMinute: 0.3,
    processingLatency: 32,
    queueDepth: 1.3,
    deadLetters: 2,
    newDeadLetters: { "15": 1, "30": 1, "60": 2, "360": 5 },
    ingestionTrend: { "15": 4, "30": 5, "60": 3, "360": 1 },
    queueTrend: { "15": 8, "30": 10, "60": 6, "360": -2 },
  },
];

/* ============================== Indicadores ============================= */

export type Kpis = {
  /** Milhões de eventos por minuto somados nas fontes selecionadas. */
  ingestionPerMinute: number;
  ingestionTrend: number;
  /** Segundos, ponderados pelo volume de cada fonte. */
  processingLatency: number;
  /** Milhares de mensagens aguardando processamento. */
  queueDepth: number;
  queueTrend: number;
  deadLetters: number;
  newDeadLetters: number;
};

/** Meta operacional de latência de processamento, em segundos. */
export const LATENCY_TARGET = 120;

/**
 * Soma as métricas aditivas e pondera as métricas de qualidade pelo volume
 * de ingestão de cada fonte, que é o peso com que ela afeta o pipeline.
 *
 * @returns `null` quando nenhuma fonte corresponde aos filtros.
 */
export function aggregateKpis(
  sources: TelemetrySource[],
  window: WindowKey,
): Kpis | null {
  if (sources.length === 0) return null;

  const volume = sources.reduce((total, source) => total + source.ingestionPerMinute, 0);
  const weighted = (pick: (source: TelemetrySource) => number) =>
    volume === 0
      ? 0
      : sources.reduce(
          (total, source) => total + pick(source) * source.ingestionPerMinute,
          0,
        ) / volume;

  return {
    ingestionPerMinute: volume,
    ingestionTrend: weighted((source) => source.ingestionTrend[window]),
    processingLatency: weighted((source) => source.processingLatency),
    queueDepth: sources.reduce((total, source) => total + source.queueDepth, 0),
    queueTrend: weighted((source) => source.queueTrend[window]),
    deadLetters: sources.reduce((total, source) => total + source.deadLetters, 0),
    newDeadLetters: sources.reduce(
      (total, source) => total + source.newDeadLetters[window],
      0,
    ),
  };
}

/* ========================= Fluxo de processamento ======================= */

/** Métrica sob análise, escolhida no filtro técnico do topo. */
export type FlowMetric = "latencia" | "ingestao" | "fila";

/** Janela do gráfico de fluxo, escolhida no próprio cartão. */
export type FlowWindow = "15" | "30" | "60";

export const FLOW_WINDOW_LABELS: Record<FlowWindow, string> = {
  "15": "Últimos 15 min",
  "30": "Últimos 30 min",
  "60": "Última hora",
};

export type FlowMetricConfig = {
  label: string;
  /** Descrição do cartão, com a meta operacional da métrica. */
  description: string;
  /** Valor máximo do eixo vertical. */
  axisMax: number;
  /** Distância entre as marcas do eixo vertical. */
  axisStep: number;
  /** Valor da linha tracejada de meta. */
  target: number;
  format: (value: number) => string;
};

const FLOW_TIMES: Record<FlowWindow, string[]> = {
  "15": ["09:16", "09:18", "09:20", "09:22", "09:24", "09:26", "09:28", "09:30"],
  "30": [
    "09:00",
    "09:03",
    "09:06",
    "09:09",
    "09:12",
    "09:15",
    "09:18",
    "09:21",
    "09:24",
    "09:27",
    "09:30",
  ],
  "60": [
    "08:30",
    "08:36",
    "08:42",
    "08:48",
    "08:54",
    "09:00",
    "09:06",
    "09:12",
    "09:18",
    "09:24",
    "09:30",
  ],
};

type FlowSeries = {
  /** Etapa de processamento, a que costuma degradar primeiro. */
  processing: number[];
  /** Etapa de ingestão, medida na entrada do pipeline. */
  ingestion: number[];
};

/** Séries do conjunto completo de fontes. O recorte é aplicado por fator. */
const FLOW_SERIES: Record<FlowMetric, Record<FlowWindow, FlowSeries>> = {
  latencia: {
    "15": {
      processing: [42, 44, 45, 48, 61, 58, 55, 52],
      ingestion: [11, 12, 12, 12, 13, 13, 12, 12],
    },
    "30": {
      processing: [18, 24, 29, 33, 38, 41, 44, 47, 61, 55, 52],
      ingestion: [9, 9, 10, 10, 11, 11, 12, 12, 13, 12, 12],
    },
    "60": {
      processing: [21, 19, 22, 20, 24, 18, 29, 38, 44, 61, 52],
      ingestion: [8, 8, 9, 9, 9, 9, 10, 11, 12, 13, 12],
    },
  },
  ingestao: {
    "15": {
      processing: [2.8, 2.8, 2.8, 2.8, 2.6, 2.7, 2.7, 2.8],
      ingestion: [2.9, 2.9, 2.9, 2.9, 2.8, 2.8, 2.8, 2.9],
    },
    "30": {
      processing: [2.6, 2.7, 2.7, 2.8, 2.8, 2.9, 2.8, 2.8, 2.6, 2.7, 2.8],
      ingestion: [2.7, 2.8, 2.8, 2.9, 2.9, 3.0, 2.9, 2.9, 2.8, 2.8, 2.9],
    },
    "60": {
      processing: [2.4, 2.5, 2.5, 2.6, 2.6, 2.6, 2.7, 2.8, 2.8, 2.6, 2.8],
      ingestion: [2.4, 2.5, 2.6, 2.6, 2.7, 2.7, 2.8, 2.9, 2.9, 2.8, 2.9],
    },
  },
  fila: {
    "15": {
      processing: [16.6, 16.8, 17.1, 17.9, 18.4, 18.3, 18.2, 18.4],
      ingestion: [5.0, 5.1, 5.1, 5.3, 5.6, 5.5, 5.4, 5.3],
    },
    "30": {
      processing: [11.2, 12.4, 13.1, 14.0, 15.2, 15.9, 16.8, 17.4, 18.4, 18.1, 18.4],
      ingestion: [4.1, 4.3, 4.4, 4.6, 4.8, 4.9, 5.1, 5.2, 5.6, 5.4, 5.3],
    },
    "60": {
      processing: [8.4, 8.1, 8.8, 8.6, 9.4, 11.2, 13.1, 15.2, 16.8, 18.4, 18.4],
      ingestion: [3.2, 3.1, 3.3, 3.3, 3.6, 4.1, 4.4, 4.8, 5.1, 5.6, 5.3],
    },
  },
};

export const FLOW_METRICS: Record<FlowMetric, FlowMetricConfig> = {
  latencia: {
    label: "latência",
    description: "Latência por fonte e etapa · meta operacional ≤ 120 s",
    axisMax: 120,
    axisStep: 40,
    target: LATENCY_TARGET,
    format: (value) => formatLatencySeconds(value),
  },
  ingestao: {
    label: "ingestão",
    description: "Ingestão por fonte e etapa · meta operacional ≥ 2,5 mi/min",
    axisMax: 4,
    axisStep: 1,
    target: 2.5,
    format: (value) => formatIngestion(value),
  },
  fila: {
    label: "profundidade da fila",
    description: "Mensagens em espera por etapa · meta operacional ≤ 20 mil",
    axisMax: 20,
    axisStep: 5,
    target: 20,
    format: (value) => formatQueue(value),
  },
};

export type FlowChartData = {
  times: string[];
  processing: number[];
  ingestion: number[];
  /** Índice do ponto de pico da etapa de processamento. */
  peakIndex: number;
};

/**
 * Recorta as séries para as fontes selecionadas.
 *
 * Latência é uma média, então o recorte escala a curva pela razão entre a
 * latência ponderada das fontes escolhidas e a do conjunto completo.
 * Ingestão e fila são somas, então a razão usada é a do próprio volume.
 */
export function buildFlowChart(
  sources: TelemetrySource[],
  metric: FlowMetric,
  window: FlowWindow,
): FlowChartData | null {
  const selected = aggregateKpis(sources, "15");
  const everything = aggregateKpis(SOURCES, "15");
  if (!selected || !everything) return null;

  const ratios: Record<FlowMetric, number> = {
    latencia: selected.processingLatency / everything.processingLatency,
    ingestao: selected.ingestionPerMinute / everything.ingestionPerMinute,
    fila: selected.queueDepth / everything.queueDepth,
  };

  const factor = ratios[metric];
  const series = FLOW_SERIES[metric][window];
  const processing = series.processing.map((value) => value * factor);
  const peak = Math.max(...processing);

  return {
    times: FLOW_TIMES[window],
    processing,
    ingestion: series.ingestion.map((value) => value * factor),
    peakIndex: processing.indexOf(peak),
  };
}

/* ======================= Concentração geográfica ======================= */

export type MapMetric = "instabilidade" | "latencia" | "perda";

export type MapMetricConfig = {
  label: string;
  /** Frase que explica a leitura da escala de cor. */
  hint: string;
  format: (value: number) => string;
};

export const MAP_METRICS: Record<MapMetric, MapMetricConfig> = {
  instabilidade: {
    label: "instabilidade",
    hint: "Cores mais intensas indicam maior instabilidade",
    format: (value) => `${value.toLocaleString("pt-BR")}%`,
  },
  latencia: {
    label: "latência p95",
    hint: "Cores mais intensas indicam latência p95 mais alta",
    format: (value) => formatLatencySeconds(value),
  },
  perda: {
    label: "perda de eventos",
    hint: "Cores mais intensas indicam maior perda de eventos",
    format: (value) =>
      `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1 })}%`,
  },
};

/** Medição de uma unidade federativa no mapa. */
export type StateTelemetry = {
  /** Sigla da unidade federativa. */
  id: string;
  name: string;
  region: string;
  /** Contorno no `viewBox` de `MAP_VIEW_BOX`. */
  path: string;
  values: Record<MapMetric, number>;
  /** Sessões observadas no estado, em milhares. */
  sessions: number;
  /** Fonte que domina a coleta no estado, para o detalhe do mapa. */
  topSource: string;
};

/**
 * Valores por estado no recorte em investigação.
 *
 * A concentração reproduz o caso do INC-4821: o Nordeste, e sobretudo
 * Pernambuco, Ceará e Bahia, responde pela maior parte da instabilidade.
 */
const STATE_VALUES: Record<
  string,
  { instabilidade: number; latencia: number; perda: number; sessions: number; topSource: string }
> = {
  AC: { instabilidade: 3, latencia: 2.6, perda: 1.4, sessions: 12, topSource: "Player" },
  AL: { instabilidade: 54, latencia: 5.8, perda: 4.1, sessions: 88, topSource: "Youbora" },
  AM: { instabilidade: 6, latencia: 3.4, perda: 2.2, sessions: 96, topSource: "Player" },
  AP: { instabilidade: 4, latencia: 3.1, perda: 1.8, sessions: 14, topSource: "Player" },
  BA: { instabilidade: 61, latencia: 6.1, perda: 4.4, sessions: 412, topSource: "Youbora" },
  CE: { instabilidade: 74, latencia: 6.8, perda: 5.2, sessions: 358, topSource: "Youbora" },
  DF: { instabilidade: 12, latencia: 2.8, perda: 0.9, sessions: 186, topSource: "Apollo" },
  ES: { instabilidade: 14, latencia: 3.2, perda: 1.1, sessions: 142, topSource: "Apollo" },
  GO: { instabilidade: 16, latencia: 3.0, perda: 1.2, sessions: 224, topSource: "Apollo" },
  MA: { instabilidade: 58, latencia: 5.9, perda: 4.3, sessions: 164, topSource: "Youbora" },
  MG: { instabilidade: 19, latencia: 3.3, perda: 1.4, sessions: 684, topSource: "Apollo" },
  MS: { instabilidade: 9, latencia: 2.5, perda: 0.8, sessions: 96, topSource: "Prometheus" },
  MT: { instabilidade: 11, latencia: 2.7, perda: 1.0, sessions: 108, topSource: "Prometheus" },
  PA: { instabilidade: 22, latencia: 4.2, perda: 2.8, sessions: 218, topSource: "Player" },
  PB: { instabilidade: 66, latencia: 6.3, perda: 4.7, sessions: 122, topSource: "Youbora" },
  PE: { instabilidade: 82, latencia: 7.4, perda: 5.8, sessions: 396, topSource: "Youbora" },
  PI: { instabilidade: 49, latencia: 5.4, perda: 3.6, sessions: 94, topSource: "Youbora" },
  PR: { instabilidade: 13, latencia: 2.9, perda: 1.0, sessions: 398, topSource: "Apollo" },
  RJ: { instabilidade: 21, latencia: 3.6, perda: 1.6, sessions: 742, topSource: "Apollo" },
  RN: { instabilidade: 63, latencia: 6.0, perda: 4.5, sessions: 118, topSource: "Youbora" },
  RO: { instabilidade: 5, latencia: 2.9, perda: 1.7, sessions: 38, topSource: "Player" },
  RR: { instabilidade: 4, latencia: 3.3, perda: 2.0, sessions: 11, topSource: "Player" },
  RS: { instabilidade: 10, latencia: 2.6, perda: 0.8, sessions: 364, topSource: "Apollo" },
  SC: { instabilidade: 8, latencia: 2.4, perda: 0.7, sessions: 246, topSource: "Apollo" },
  SE: { instabilidade: 51, latencia: 5.6, perda: 3.9, sessions: 62, topSource: "Youbora" },
  SP: { instabilidade: 24, latencia: 3.8, perda: 1.8, sessions: 1680, topSource: "Apollo" },
  TO: { instabilidade: 17, latencia: 3.5, perda: 2.1, sessions: 46, topSource: "Player" },
};

/** Unidades federativas com contorno e medição, prontas para o mapa. */
export const STATES: StateTelemetry[] = STATE_SHAPES.map((shape) => {
  const values = STATE_VALUES[shape.id];

  return {
    ...shape,
    values: {
      instabilidade: values.instabilidade,
      latencia: values.latencia,
      perda: values.perda,
    },
    sessions: values.sessions,
    topSource: values.topSource,
  };
});

/** Soma de sessões por grande região, para o resumo abaixo do mapa. */
export function summarizeByRegion(
  states: StateTelemetry[],
  metric: MapMetric,
): { region: string; value: number; sessions: number }[] {
  const buckets = new Map<string, { total: number; weight: number; sessions: number }>();

  for (const state of states) {
    const bucket = buckets.get(state.region) ?? { total: 0, weight: 0, sessions: 0 };
    // A média é ponderada pelas sessões: um estado com 11 mil sessões não pode
    // pesar o mesmo que São Paulo na leitura da região.
    bucket.total += state.values[metric] * state.sessions;
    bucket.weight += state.sessions;
    bucket.sessions += state.sessions;
    buckets.set(state.region, bucket);
  }

  return Array.from(buckets, ([region, bucket]) => ({
    region,
    value: bucket.weight === 0 ? 0 : bucket.total / bucket.weight,
    sessions: bucket.sessions,
  })).sort((a, b) => b.value - a.value);
}

/* ============================== Formatação ============================= */

/** Formata `2.8` como `2,8 mi/min`. */
export function formatIngestion(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi/min`;
}

/** Formata `18.4` como `18,4 mil`. */
export function formatQueue(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

/**
 * Formata `120` como `120 s`, sem converter para minutos.
 *
 * As metas e os eixos de latência são lidos em segundos, então a conversão
 * de {@link formatSeconds} atrapalharia a comparação com o limite de 120 s.
 */
export function formatLatencySeconds(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}

/** Formata `48` como `48 s` e `272` como `4 min 32 s`. */
export function formatSeconds(value: number): string {
  if (value < 60) {
    return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  }

  const rounded = Math.round(value);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;

  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** Formata `4` como `+4%` e `-3` como `-3%`. */
export function formatTrend(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("pt-BR")}%`;
}

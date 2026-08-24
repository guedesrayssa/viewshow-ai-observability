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

export const WORKERS = Array.from(new Set(SOURCES.map((source) => source.worker))).sort();

/** Fonte cujo atraso precisa ser anunciado no topo da tela. */
export const DELAYED_SOURCE = SOURCES.find((source) => source.state === "atrasado");

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

export type Region = {
  id: string;
  name: string;
  /**
   * Contorno da região no `viewBox` 0 0 100 108.
   *
   * É uma silhueta simplificada do Brasil, desenhada à mão a partir das
   * coordenadas de pontos conhecidos do território: a longitude de -74 a
   * -34,8 vira o eixo horizontal e a latitude de +5,3 a -33,75 vira o
   * vertical. Serve para a leitura comparativa entre as regiões, não para
   * consulta cartográfica.
   */
  path: string;
  values: Record<MapMetric, number>;
};

export const REGIONS: Region[] = [
  {
    id: "norte",
    name: "Norte",
    /* Roraima e Amapá ao norte, o litoral até a divisa Pará/Maranhão, a
       divisa com o Nordeste até o encontro Tocantins/Goiás/Bahia e a
       fronteira oeste com Peru e Bolívia. */
    path:
      "M35,0 L41,11 L51,9 L57,2 L60,15 L66,18 L70,17 " +
      "L68,31 L71,42 L70,49 L70,51 " +
      "L60,51 L54,46 L41,44 L34,48 L34,52 " +
      "L22,45 L14,45 L3,41 L0,35 L10,26 L10,19 L17,11 L26,4 Z",
    values: { instabilidade: 4, latencia: 2.9, perda: 1.9 },
  },
  {
    id: "nordeste",
    name: "Nordeste",
    /* O litoral do Maranhão até o extremo leste na Paraíba, a descida até o
       sul da Bahia e a volta pela divisa com Minas Gerais e Goiás. */
    path:
      "M70,17 L76,22 L82,23 L91,25 L99,31 L100,34 L98,41 L91,51 L89,64 L88,66 " +
      "L84,60 L78,58 L71,55 L71,54 L70,51 " +
      "L70,49 L71,42 L68,31 Z",
    values: { instabilidade: 68, latencia: 6.4, perda: 4.8 },
  },
  {
    id: "centro-oeste",
    name: "Centro-Oeste",
    /* Mato Grosso ao norte, a divisa leste com Bahia e Minas Gerais, a
       divisa sul com São Paulo e Paraná e a fronteira com Paraguai e
       Bolívia a oeste. */
    path:
      "M34,52 L34,48 L41,44 L54,46 L60,51 L70,51 L71,54 " +
      "L68,59 L68,64 L60,69 L53,77 L50,81 " +
      "L47,77 L41,76 L42,67 Z",
    values: { instabilidade: 2, latencia: 2.1, perda: 0.5 },
  },
  {
    id: "sudeste",
    name: "Sudeste",
    /* A divisa de Minas Gerais com a Bahia, o litoral do Espírito Santo até
       a divisa São Paulo/Paraná e a volta pela divisa com o Centro-Oeste. */
    path:
      "M71,54 L71,55 L78,58 L84,60 L88,66 " +
      "L86,71 L82,78 L79,78 L71,81 L66,84 " +
      "L60,81 L53,77 L60,69 L68,64 L68,59 Z",
    values: { instabilidade: 18, latencia: 3.1, perda: 1.2 },
  },
  {
    id: "sul",
    name: "Sul",
    /* A divisa com São Paulo, o litoral do Paraná até o Chuí e a fronteira
       com Uruguai, Argentina e Paraguai. */
    path:
      "M53,77 L60,81 L66,84 L65,91 L62,96 L56,103 L53,108 " +
      "L46,100 L42,98 L46,90 L50,85 L50,81 Z",
    values: { instabilidade: 8, latencia: 2.4, perda: 0.7 },
  },
];

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

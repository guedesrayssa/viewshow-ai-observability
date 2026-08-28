/**
 * @file events-data.ts
 * Dados de exemplo e derivações da tela de Eventos.
 *
 * Cobre a US-ENG-02 (alternar entre o evento normalizado e a fonte original)
 * e a US-ENG-03 (inspecionar a linha do tempo de uma sessão), com os tipos
 * mínimos definidos em seus critérios de aceitação: `request`, `vitals`,
 * `screen_view`, `video_view`, `session` e `error`.
 *
 * As sessões reproduzem o recorte do INC-4821 (Falhas de reprodução em TVs
 * LG, Smart TV · Nordeste · App 4.2.1) já investigado nas telas de
 * Incidentes e Evidências: o PLAYER_DECODER_FALLBACK e o intervalo de
 * horário aqui coincidem com o marco "Decoder +18x" da linha do tempo de
 * evidências, enquanto a integração com a telemetria não existe.
 */

import type { BadgeTone } from "@/components/ui/badge";

/** Tipo mínimo de evento, conforme a US-ENG-03. */
export type EventCategory =
  | "request"
  | "vitals"
  | "screen_view"
  | "video_view"
  | "session"
  | "error";

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  request: "Requisição",
  vitals: "Sinais vitais",
  screen_view: "Tela",
  video_view: "Vídeo",
  session: "Sessão",
  error: "Erro",
};

/**
 * Cor do rótulo de tipo na tabela. Reaproveita as mesmas classes usadas para
 * a urgência dos incidentes, para que "Erro" e "Sinais vitais" carreguem a
 * mesma leitura de severidade nas duas telas.
 */
export const CATEGORY_TEXT_CLASSES: Record<EventCategory, string> = {
  request: "text-brand-blue",
  vitals: "text-brand-orange",
  screen_view: "text-brand-blue",
  video_view: "text-brand-blue",
  session: "text-brand-blue",
  error: "text-critical",
};

/** Estatística exibida nas abas por tipo, no topo da tela. */
export type CategoryStat = {
  key: EventCategory | "all";
  label: string;
  total: string;
};

/** Contagens do protótipo de alta fidelidade, enquanto a integração não existe. */
export const CATEGORY_STATS: CategoryStat[] = [
  { key: "all", label: "Todos", total: "24,8M" },
  { key: "request", label: "Requisição", total: "11,2M" },
  { key: "vitals", label: "Sinais vitais", total: "1,2M" },
  { key: "screen_view", label: "Tela", total: "3,8M" },
  { key: "video_view", label: "Vídeo", total: "6,4M" },
  { key: "session", label: "Sessão", total: "1,9M" },
  { key: "error", label: "Erro", total: "342/min" },
];

/** Dado normalizado e ligação com a fonte original, conforme a US-ENG-02. */
export type EventDetail = {
  metric: string;
  timestamp: string;
  tags: string[];
  value: string;
  /** Quando `false`, o dado bruto não tem correspondência direta na fonte. */
  rawAvailable: boolean;
  rawSnippet?: string;
};

export type CorrelatedEvent = {
  id: string;
  time: string;
  /** Minutos desde o evento, para o filtro de período. */
  minutesAgo: number;
  category: EventCategory;
  source: string;
  entity: string;
  summary: string;
  quality: { label: string; tone: BadgeTone };
  deviceType: string;
  region: string;
  appVersion: string;
  detail: EventDetail;
};

/** Exemplo fixo, com os mesmos casos do protótipo de alta fidelidade. */
export const EVENTS: CorrelatedEvent[] = [
  {
    id: "playback-stall-fatal",
    time: "09:31:58",
    minutesAgo: 0,
    category: "error",
    source: "Youbora",
    entity: "reprodução",
    summary: "PLAYBACK_STALL · fatal",
    quality: { label: "vinculado", tone: "success" },
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    detail: {
      metric: "player.playback_stall",
      timestamp: "09:31:58.412",
      tags: ["severity:fatal", "device:lg_webos", "incidente:INC-4821"],
      value: "1 ocorrência",
      rawAvailable: true,
      rawSnippet: '{"event":"PLAYBACK_STALL","severity":"fatal","device":"lg_webos_6"}',
    },
  },
  {
    id: "http-200-p99",
    time: "09:31:42",
    minutesAgo: 1,
    category: "request",
    source: "Apollo",
    entity: "operation/playback",
    summary: "HTTP 200 · p99 310 ms",
    quality: { label: "normalizado", tone: "info" },
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    detail: {
      metric: "http.server.duration",
      timestamp: "09:31:42.098",
      tags: ["route:operation/playback", "status:200"],
      value: "310 ms (p99)",
      rawAvailable: true,
      rawSnippet: '{"status":200,"duration_ms":310,"route":"operation/playback"}',
    },
  },
  {
    id: "anr-player",
    time: "09:31:15",
    minutesAgo: 1,
    category: "vitals",
    source: "Player",
    entity: "app/webOS",
    summary: "ANR · 6,2 s",
    quality: { label: "atraso 18 s", tone: "warning" },
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    detail: {
      metric: "vitals.anr_duration",
      timestamp: "09:31:33.000 · ocorrido às 09:31:15",
      tags: ["platform:webos", "anr:true"],
      value: "6,2 s",
      rawAvailable: true,
      rawSnippet: '{"anr_ms":6200,"platform":"webos"}',
    },
  },
  {
    id: "decoder-fallback",
    time: "09:30:40",
    minutesAgo: 2,
    category: "error",
    source: "signal_point",
    entity: "player/decoder",
    summary: "PLAYER_DECODER_FALLBACK · +18×",
    quality: { label: "possível duplicata", tone: "warning" },
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    detail: {
      metric: "player.decoder_fallback",
      timestamp: "09:30:40.221",
      tags: ["componente:decoder", "contagem:18"],
      value: "18 ocorrências",
      rawAvailable: false,
    },
  },
  {
    id: "playback-started",
    time: "09:30:12",
    minutesAgo: 2,
    category: "video_view",
    source: "Youbora",
    entity: "sessão/vídeo",
    summary: "Reprodução iniciada · 2,1 s",
    quality: { label: "fonte íntegra", tone: "success" },
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    detail: {
      metric: "video.playback_start",
      timestamp: "09:30:12.054",
      tags: ["startup_time_s:2.1"],
      value: "2,1 s até o primeiro quadro",
      rawAvailable: true,
      rawSnippet: '{"startup_s":2.1,"session":"sessão/vídeo"}',
    },
  },
];

export const DEVICE_TYPES = Array.from(new Set(EVENTS.map((event) => event.deviceType)));
export const REGIONS = Array.from(new Set(EVENTS.map((event) => event.region)));
export const APP_VERSIONS = Array.from(new Set(EVENTS.map((event) => event.appVersion)));
export const SOURCES = Array.from(new Set(EVENTS.map((event) => event.source)));

export type PeriodKey = "30" | "60" | "360" | "1440";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Últimos 30 min",
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

/** Filtros avançados citados no RF04, sem tela própria enquanto não existem. */
export const ADVANCED_FILTERS = [
  "Sistema operacional",
  "UF ou POP",
  "ISP",
  "CDN",
  "Conteúdo ou sinal",
  "Componente",
  "Ambiente",
];

/* ========================= Volume temporal dos eventos ========================= */

/** Janelas oferecidas no gráfico de volume. */
export type VolumePeriodKey = "30" | "60" | "180";

export const VOLUME_PERIOD_LABELS: Record<VolumePeriodKey, string> = {
  "30": "Período: últimos 30 min",
  "60": "Período: última hora",
  "180": "Período: últimas 3 horas",
};

export type VolumeSeries = {
  times: string[];
  values: number[];
  peakIndex: number;
  /**
   * Índices de início e fim da janela anômala. `null` quando a origem não faz
   * detecção — o destaque some em vez de apontar uma janela que ninguém mediu.
   */
  anomalyRange: [number, number] | null;
  axisMax: number;
  axisTicks: number[];
};

/** Séries de exemplo por janela, com o mesmo pico do protótipo. */
export const VOLUME_DATASETS: Record<VolumePeriodKey, VolumeSeries> = {
  "30": {
    times: ["09:02", "09:07", "09:12", "09:17", "09:22", "09:27", "09:32"],
    values: [5200, 6400, 6000, 15200, 24800, 19000, 13400],
    peakIndex: 4,
    anomalyRange: [3, 5],
    axisMax: 30000,
    axisTicks: [0, 15000, 30000],
  },
  "60": {
    times: ["08:35", "08:45", "08:55", "09:05", "09:15", "09:25", "09:35"],
    values: [4100, 4800, 5600, 6200, 18400, 24800, 12600],
    peakIndex: 5,
    anomalyRange: [4, 6],
    axisMax: 30000,
    axisTicks: [0, 15000, 30000],
  },
  "180": {
    times: ["06:40", "07:10", "07:40", "08:10", "08:40", "09:10", "09:40"],
    values: [3200, 3800, 4400, 4900, 6100, 24800, 11800],
    peakIndex: 5,
    anomalyRange: [4, 6],
    axisMax: 30000,
    axisTicks: [0, 15000, 30000],
  },
};

/** Formata `24800` como `24,8 mil`. */
export function formatVolume(value: number): string {
  if (value < 1000) return value.toLocaleString("pt-BR");
  return `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

/** Formata `24800` como `24,8 mil/min`. */
export function formatVolumePerMinute(value: number): string {
  return `${formatVolume(value)}/min`;
}

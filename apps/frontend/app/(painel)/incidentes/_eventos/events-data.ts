import type { BadgeTone } from "@/components/ui/badge";

export type EventCategory =
  "signal_observation" | "live_event" | "live_event_context";

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  signal_observation: "Sinal observado",
  live_event: "Evento ao vivo",
  live_event_context: "Contexto ao vivo",
};

export const CATEGORY_TEXT_CLASSES: Record<EventCategory, string> = {
  signal_observation: "text-brand-orange",
  live_event: "text-brand-blue",
  live_event_context: "text-ink-brand",
};

export type CategoryStat = {
  key: EventCategory | "all";
  label: string;
  total: string;
};

export type EventDetail = {
  metric: string;
  timestamp: string;
  tags: string[];
  value: string;
  rawAvailable: boolean;
  rawReason: string;
  sourceRecordId: string;
  canonicalLocator: string;
};

export type CorrelatedEvent = {
  id: string;
  time: string;
  minutesAgo: number;
  category: EventCategory;
  source: string;
  entity: string;
  summary: string;
  quality: { label: string; tone: BadgeTone };
  deviceType: string;
  region: string;
  appVersion: string;
  /** Incidentes aos quais o evento foi correlacionado. */
  incidentIds: string[];
  detail: EventDetail;
};

/**
 * Janelas aceitas pela API de eventos. A tabela e o gráfico de volume usam a
 * mesma: dois seletores de período na mesma tela mostravam recortes
 * diferentes lado a lado.
 */
export type PeriodKey = "30" | "60" | "360" | "1440" | "older" | "all";

/**
 * Períodos oferecidos na tela (e aceitos na URL). As janelas curtas saíram:
 * contadas a partir de agora, esvaziavam a lista sempre que o dado mais
 * recente tinha mais de meia hora. Recortes mais finos usam o intervalo
 * personalizado, com início e fim explícitos.
 */
export const PERIOD_KEYS: PeriodKey[] = ["1440", "older", "all"];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Últimos 30 min",
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
  older: "Mais de 24 horas",
  all: "Todo o período",
};

/** Janela da API para cada período da tela. */
export const PERIOD_WINDOWS: Record<PeriodKey, string> = {
  "30": "30m",
  "60": "1h",
  "360": "6h",
  "1440": "24h",
  // Sem janela na API: vira um intervalo explícito (ver events-resource).
  older: "all",
  all: "all",
};

/** Mantido como sinônimo: o gráfico de volume segue o período da lista. */
export type VolumePeriodKey = PeriodKey;

export type EventSort = "recent" | "oldest";

export const SORT_LABELS: Record<EventSort, string> = {
  recent: "Mais recentes primeiro",
  oldest: "Mais antigos primeiro",
};

export type VolumeSeries = {
  times: string[];
  values: number[];
  peakIndex: number;
  anomalyRange: [number, number] | null;
  axisMax: number;
  axisTicks: number[];
};

export function formatVolume(value: number): string {
  if (value < 1000) return value.toLocaleString("pt-BR");
  return `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

export function formatVolumePerMinute(value: number): string {
  return `${formatVolume(value)}/min`;
}

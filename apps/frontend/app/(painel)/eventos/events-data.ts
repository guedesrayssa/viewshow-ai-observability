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
  detail: EventDetail;
};

export type PeriodKey = "30" | "60" | "360" | "1440";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Últimos 30 min",
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

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

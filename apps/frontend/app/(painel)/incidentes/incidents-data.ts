/**
 * @file incidents-data.ts
 * Tipos e conjunto de exemplo da tela de Incidentes.
 *
 * Separado da tela pelo mesmo motivo de `eventos/events-data.ts`: o componente
 * cuida da apresentação, e o dado tem um lugar próprio para ser substituído
 * pela telemetria real sem tocar no desenho.
 */

import type { BadgeTone } from "@/components/ui/badge";

export type Urgency = "P1" | "P2" | "P3" | "P4";

export type Incident = {
  id: string;
  urgency: Urgency;
  title: string;
  segment: string;
  devices: number | null;
  startedAt: string;
  startedMinutesAgo: number;
  component: string;
  deviceType: string;
  region: string;
  appVersion: string;
};

export const URGENCY_META: Record<
  Urgency,
  { label: string; badgeTone: BadgeTone; borderClass: string }
> = {
  P1: {
    label: "P1 Crítico",
    badgeTone: "critical",
    borderClass: "border-l-critical",
  },
  P2: {
    label: "P2 Alto",
    badgeTone: "warning",
    borderClass: "border-l-brand-orange",
  },
  P3: {
    label: "P3 Médio",
    badgeTone: "info",
    borderClass: "border-l-brand-blue-light",
  },
  P4: {
    label: "P4 Baixo",
    badgeTone: "success",
    borderClass: "border-l-success",
  },
};

/** Cor do valor de dispositivos afetados, reforçando a urgência. */
export const DEVICE_COUNT_CLASSES: Partial<Record<Urgency, string>> = {
  P1: "text-critical",
  P2: "text-brand-orange",
};

/** Exemplo fixo, com os mesmos casos do protótipo de alta fidelidade. */
export const INCIDENTS: Incident[] = [
  {
    id: "falhas-reproducao-tvs-lg",
    urgency: "P1",
    title: "Falhas de reprodução em TVs LG",
    segment: "12,4 mil sessões · Nordeste · webOS 6.0",
    devices: 8420,
    startedAt: "09:18",
    startedMinutesAgo: 12,
    component: "Player",
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
  },
  {
    id: "timeout-cdn-nordeste",
    urgency: "P2",
    title: "Timeout de CDN no Nordeste",
    segment: "3,2 mil sessões · POP Recife · Fastly",
    devices: 2150,
    startedAt: "08:52",
    startedMinutesAgo: 38,
    component: "CDN",
    deviceType: "Multiplataforma",
    region: "Nordeste",
    appVersion: "App 4.1.8",
  },
  {
    id: "licencas-drm-tvs-samsung",
    urgency: "P3",
    title: "Licenças DRM expiradas em TVs Samsung",
    segment: "1,1 mil sessões · Tizen 7 · conteúdo VOD",
    devices: 824,
    startedAt: "08:36",
    startedMinutesAgo: 54,
    component: "DRM",
    deviceType: "Smart TV",
    region: "Sul",
    appVersion: "App 4.2.1",
  },
  {
    id: "tokens-autenticacao-invalidos",
    urgency: "P4",
    title: "Tokens de autenticação inválidos",
    segment: "430 sessões · múltiplas plataformas",
    devices: 390,
    startedAt: "07:58",
    startedMinutesAgo: 92,
    component: "Identidade",
    deviceType: "Mobile",
    region: "Nacional",
    appVersion: "App 4.0.5",
  },
];

export const DEVICE_TYPES = Array.from(
  new Set(INCIDENTS.map((incident) => incident.deviceType)),
);
export const REGIONS = Array.from(
  new Set(INCIDENTS.map((incident) => incident.region)),
);
export const APP_VERSIONS = Array.from(
  new Set(INCIDENTS.map((incident) => incident.appVersion)),
);

export type PeriodKey = "30" | "60" | "360" | "1440";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Últimos 30 min",
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

export type SortKey = "urgency" | "devices" | "recent";

export const SORT_LABELS: Record<SortKey, string> = {
  urgency: "Ordenar: maior urgência",
  devices: "Ordenar: mais dispositivos",
  recent: "Ordenar: mais recente",
};

/** Ordena a lista pelo critério escolhido, sem alterar o original. */
export function sortIncidents(
  incidents: Incident[],
  sort: SortKey,
): Incident[] {
  const sorted = [...incidents];

  if (sort === "devices") {
    sorted.sort((a, b) => (b.devices ?? -1) - (a.devices ?? -1));
  } else if (sort === "recent") {
    sorted.sort((a, b) => a.startedMinutesAgo - b.startedMinutesAgo);
  } else {
    sorted.sort((a, b) => a.urgency.localeCompare(b.urgency));
  }

  return sorted;
}

/* ===================== Dispositivos afetados por horário ==================== */

export type ChartLevel = "critical" | "warning";

export type ChartBucket = {
  time: string;
  value: number;
  level: ChartLevel;
};

export type ChartPeriodKey = "60" | "360" | "1440";

export const CHART_PERIOD_LABELS: Record<ChartPeriodKey, string> = {
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

/** Séries de exemplo por janela de tempo. */
export const CHART_DATASETS: Record<ChartPeriodKey, ChartBucket[]> = {
  "60": [
    { time: "09:00", value: 3100, level: "warning" },
    { time: "09:10", value: 5600, level: "warning" },
    { time: "09:20", value: 4700, level: "warning" },
    { time: "09:30", value: 7200, level: "warning" },
    { time: "09:40", value: 9800, level: "critical" },
    { time: "09:50", value: 12400, level: "critical" },
    { time: "10:00", value: 10100, level: "critical" },
    { time: "10:10", value: 8500, level: "warning" },
  ],
  "360": [
    { time: "05:00", value: 4200, level: "warning" },
    { time: "06:00", value: 6800, level: "warning" },
    { time: "07:00", value: 5100, level: "warning" },
    { time: "08:00", value: 11300, level: "critical" },
    { time: "09:00", value: 18700, level: "critical" },
    { time: "10:00", value: 10100, level: "warning" },
  ],
  "1440": [
    { time: "00h", value: 2600, level: "warning" },
    { time: "03h", value: 1900, level: "warning" },
    { time: "06h", value: 3400, level: "warning" },
    { time: "09h", value: 18700, level: "critical" },
    { time: "12h", value: 14200, level: "warning" },
    { time: "15h", value: 9600, level: "warning" },
    { time: "18h", value: 21300, level: "critical" },
    { time: "21h", value: 7800, level: "warning" },
  ],
};

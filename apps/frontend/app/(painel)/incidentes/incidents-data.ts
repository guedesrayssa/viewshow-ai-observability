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
  /** Identificador interno, usado nas rotas e nas chamadas à API. */
  id: string;
  /** Código legível (`INC-E2E-0044`); cai para o id quando não há número. */
  code: string;
  urgency: Urgency;
  /** Título da origem; vazio quando só repete o código. */
  title: string;
  /** Estado da investigação, como a API publica (`investigating`...). */
  status: string;
  segment: string;
  devices: number | null;
  /** Início já formatado com o dia ("Hoje, 19:00"). */
  startedAt: string;
  /** Início em ISO, para exportação e ordenação. */
  startedAtIso: string;
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
    code: "INC-4821",
    urgency: "P1",
    title: "Falhas de reprodução em TVs LG",
    status: "investigating",
    startedAtIso: "",
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
    code: "INC-4822",
    urgency: "P2",
    title: "Timeout de CDN no Nordeste",
    status: "detected",
    startedAtIso: "",
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
    code: "INC-4823",
    urgency: "P3",
    title: "Licenças DRM expiradas em TVs Samsung",
    status: "confirmed",
    startedAtIso: "",
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
    code: "INC-4824",
    urgency: "P4",
    title: "Tokens de autenticação inválidos",
    status: "resolved",
    startedAtIso: "",
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

/**
 * Períodos da lista. "Todo o período" existe porque a Visão Geral lista
 * incidentes abertos há mais de 24 horas: sem ele, o "Ver todos" levava a uma
 * lista em que esses incidentes não apareciam.
 */
export type PeriodKey = "30" | "60" | "360" | "1440" | "older" | "all";

/**
 * Períodos oferecidos na tela (e aceitos na URL). As janelas curtas saíram:
 * contadas a partir de agora, esvaziavam a lista sempre que o dado mais
 * recente tinha mais de meia hora, e pareciam indicar que não havia
 * incidentes.
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

/**
 * Se um incidente aberto há `minutesAgo` minutos entra no período. As janelas
 * relativas também vão à API (`window=24h`); este recorte na tela é o que faz
 * "mais de 24 horas", que não tem janela na API e é lido com `window=all`.
 */
export function withinPeriod(minutesAgo: number, period: PeriodKey | string): boolean {
  if (period === "1440") return minutesAgo <= 1440;
  if (period === "older") return minutesAgo > 1440;
  if (period === "360") return minutesAgo <= 360;
  if (period === "60") return minutesAgo <= 60;
  if (period === "30") return minutesAgo <= 30;
  return true;
}

/**
 * A lista abre em todo o período, como a Visão Geral. Com "últimas 24 horas"
 * como padrão, o item Incidentes da navegação mostrava menos incidentes que o
 * "Ver todos" da Visão Geral — e, com um dataset histórico, nenhum, porque as
 * janelas relativas contam a partir de agora.
 */
export const DEFAULT_PERIOD: PeriodKey = "all";

/** Filtros que a API de incidentes aceita além do período. */
export const PRIORITY_FILTERS: Urgency[] = ["P1", "P2", "P3", "P4"];

export const STATUS_FILTERS = [
  "detected",
  "investigating",
  "confirmed",
  "resolved",
  "closed",
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export type SortKey = "urgency" | "devices" | "recent";

export const SORT_KEYS: SortKey[] = ["urgency", "devices", "recent"];

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

  // Empates caem para o mais recente: é o que a pessoa de plantão olha antes.
  const byRecent = (a: Incident, b: Incident) =>
    a.startedMinutesAgo - b.startedMinutesAgo;

  if (sort === "devices") {
    sorted.sort(
      (a, b) => (b.devices ?? -1) - (a.devices ?? -1) || byRecent(a, b),
    );
  } else if (sort === "recent") {
    sorted.sort(byRecent);
  } else {
    sorted.sort((a, b) => a.urgency.localeCompare(b.urgency) || byRecent(a, b));
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

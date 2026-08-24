import type { BadgeTone } from "@/components/ui/badge";
import type { CardAccent } from "@/components/ui/card";

export type StatAccent = Exclude<CardAccent, "none" | "brand">;
export type DeltaTone = "accent" | "neutral";

export type StatCardData = {
  id: string;
  label: string;
  value: string;
  delta: string;
  accent: StatAccent;
  deltaTone: DeltaTone;
};

export const STATS: StatCardData[] = [
  {
    id: "error-rate",
    label: "Taxa de erros",
    value: "342/min",
    delta: "+18% vs. base",
    accent: "critical",
    deltaTone: "accent",
  },
  {
    id: "latency-p95",
    label: "Latência p95",
    value: "310 ms",
    delta: "+6% vs. base",
    accent: "warning",
    deltaTone: "accent",
  },
  {
    id: "affected-sessions",
    label: "Sessões afetadas",
    value: "12,4 mil",
    delta: "2,8% do recorte",
    accent: "info",
    deltaTone: "neutral",
  },
];

export type ExperiencePoint = {
  label: string;
  value: number;
};

export const EXPERIENCE_HEALTH_SERIES: ExperiencePoint[] = [
  { label: "09:00", value: 24 },
  { label: "09:03", value: 18 },
  { label: "09:06", value: 34 },
  { label: "09:09", value: 45 },
  { label: "09:12", value: 92 },
  { label: "09:15", value: 95 },
  { label: "09:18", value: 150 },
  { label: "09:21", value: 342 },
  { label: "09:24", value: 290 },
  { label: "09:27", value: 245 },
  { label: "09:30", value: 230 },
];

export const EXPERIENCE_HEALTH_BASELINE = 100;
export const EXPERIENCE_HEALTH_ANOMALY_RANGE: [number, number] = [6, 8];
export const EXPERIENCE_HEALTH_PEAK_INDEX = 7;

export type IncidentStatus = Exclude<BadgeTone, "neutral" | "brand">;

export type IncidentData = {
  id: string;
  title: string;
  sessions: string;
  timeAgo: string;
  status: IncidentStatus;
  statusLabel: string;
};

export const INCIDENTS: IncidentData[] = [
  {
    id: "tv-lg-failures",
    title: "Falhas em TVs LG",
    sessions: "12,4 mil sessões",
    timeAgo: "há 18 min",
    status: "critical",
    statusLabel: "Crítico",
  },
  {
    id: "cdn-timeout",
    title: "Timeout de CDN",
    sessions: "2,1 mil sessões",
    timeAgo: "há 31 min",
    status: "warning",
    statusLabel: "Atenção",
  },
  {
    id: "drm-expired",
    title: "DRM expirado",
    sessions: "824 sessões",
    timeAgo: "há 42 min",
    status: "info",
    statusLabel: "Ativo",
  },
  {
    id: "invalid-token",
    title: "Token inválido",
    sessions: "430 sessões",
    timeAgo: "há 1 h",
    status: "success",
    statusLabel: "Estável",
  },
];

export type SelectOption = {
  value: string;
  label: string;
};

export const TIME_RANGE_OPTIONS: SelectOption[] = [
  { value: "15m", label: "Últimos 15 min" },
  { value: "30m", label: "Últimos 30 min" },
  { value: "1h", label: "Última 1 h" },
  { value: "24h", label: "Últimas 24 h" },
];

export const DEVICE_OPTIONS: SelectOption[] = [
  { value: "smart-tv", label: "Smart TV" },
  { value: "mobile", label: "Mobile" },
  { value: "web", label: "Web" },
  { value: "desktop", label: "Desktop" },
];

export const REGION_OPTIONS: SelectOption[] = [
  { value: "norte", label: "Norte" },
  { value: "nordeste", label: "Nordeste" },
  { value: "centro-oeste", label: "Centro-Oeste" },
  { value: "sudeste", label: "Sudeste" },
  { value: "sul", label: "Sul" },
];

export const APP_VERSION_OPTIONS: SelectOption[] = [
  { value: "4.2.1", label: "App 4.2.1" },
  { value: "4.2.0", label: "App 4.2.0" },
  { value: "4.1.5", label: "App 4.1.5" },
];

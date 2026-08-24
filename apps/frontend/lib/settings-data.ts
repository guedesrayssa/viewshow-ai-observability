import type { SelectOption } from "@/lib/dashboard-data";

export const TEAM_OPTIONS: SelectOption[] = [
  { value: "observabilidade-player", label: "Observabilidade / Player" },
  { value: "observabilidade-backend", label: "Observabilidade / Backend" },
  { value: "plataforma", label: "Plataforma" },
];

export const TIMEZONE_OPTIONS: SelectOption[] = [
  { value: "america/sao_paulo", label: "Brasília · UTC-03:00" },
  { value: "america/manaus", label: "Manaus · UTC-04:00" },
  { value: "utc", label: "UTC · UTC+00:00" },
];

export const DEFAULT_PERIOD_OPTIONS: SelectOption[] = [
  { value: "15m", label: "Últimos 15 minutos" },
  { value: "30m", label: "Últimos 30 minutos" },
  { value: "1h", label: "Última 1 hora" },
  { value: "24h", label: "Últimas 24 horas" },
];

export const INITIAL_SCREEN_OPTIONS: SelectOption[] = [
  { value: "visao-geral", label: "Visão Geral" },
  { value: "incidentes", label: "Incidentes" },
  { value: "monitoramento", label: "Monitoramento" },
];

export type AccountProfile = {
  name: string;
  email: string;
  role: string;
  authMethod: string;
  lastAccess: string;
  activeSessions: number;
};

export const ACCOUNT_PROFILE: AccountProfile = {
  name: "Giovanna Matsu",
  email: "giovanna.matsu@globo.com",
  role: "Engenheira de Software",
  authMethod: "SSO Globo",
  lastAccess: "Hoje, 09:42",
  activeSessions: 2,
};

export type NotificationPreference = {
  id: string;
  title: string;
  description: string;
};

export const NOTIFICATION_PREFERENCES: NotificationPreference[] = [
  {
    id: "critical-incidents",
    title: "Incidentes críticos",
    description: "Alertar quando um P1 for aberto ou agravado",
  },
  {
    id: "telemetry-delay",
    title: "Atraso de telemetria",
    description: "Alertar quando a atualização exceder dois minutos",
  },
];

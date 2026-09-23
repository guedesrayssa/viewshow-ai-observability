/**
 * @file evidence-data.ts
 * Tipos e conjunto de exemplo da tela de Evidências.
 *
 * Reproduz o caso do INC-4821 (Falhas de reprodução em TVs LG) usado no
 * protótipo de alta fidelidade e continuado nas telas de Incidentes e Eventos.
 */

import type { BadgeTone } from "@/components/ui/badge";

export type IncidentSummary = {
  id: string;
  title: string;
  startedMinutesAgo: number;
  severity: string;
  investigationStatus: string;
  /**
   * Dispositivos, não sessões: é o que a API operacional conta. O rótulo da
   * tela acompanha, para que o número não afirme uma medição que não existe.
   */
  affectedDevices: number | null;
};

export type Hypothesis = {
  title: string;
  component: string;
  confidence: number | null;
  summary: string;
};

export type ConcentrationSlice = {
  label: string;
  percentage: number;
};

export type EvidenceStrength = "forte" | "neutra" | "contra";

export const STRENGTH_META: Record<
  EvidenceStrength,
  { label: string; tone: BadgeTone }
> = {
  forte: { label: "Forte", tone: "critical" },
  neutra: { label: "Neutra", tone: "neutral" },
  contra: { label: "Contra", tone: "success" },
};

export type EvidenceDetail = {
  metric: string;
  sample: string;
};

export type EvidenceSource = {
  id: string;
  source: string;
  summary: string;
  strength: EvidenceStrength;
  detail: string;
};

export type TimelineTone = "info" | "warning" | "critical" | "navy";

export const TIMELINE_DOT_CLASSES: Record<TimelineTone, string> = {
  info: "bg-brand-blue-light",
  warning: "bg-brand-orange",
  critical: "bg-critical",
  navy: "bg-brand-navy",
};

export type TimelineMark = {
  time: string;
  label: string;
  source: string;
  tone: TimelineTone;
};

export type ChangeLikelihood = {
  label: string;
  cause: string;
  percentage: number;
  tone: BadgeTone;
};

/** Situação da revisão humana da hipótese. */
export type ReviewStatus = "pending" | "confirmed" | "refuted";

/** Tudo o que a tela de Evidências desenha em uma leitura. */
export type EvidenceData = {
  incidentId: string;
  incident: IncidentSummary;
  /** `null` enquanto o incidente não passou por diagnóstico. */
  hypothesis: Hypothesis | null;
  /** O que a API tem registrado sobre a revisão, na hora da leitura. */
  reviewStatus: ReviewStatus;
  concentration: ConcentrationSlice[];
  concentrationNote: string;
  sources: EvidenceSource[];
  timeline: TimelineMark[];
  changes: ChangeLikelihood[];
};

export const INCIDENT: IncidentSummary = {
  id: "INC-4821",
  title: "Falhas de reprodução em TVs LG",
  startedMinutesAgo: 18,
  severity: "Crítico",
  investigationStatus: "Em investigação",
  affectedDevices: 12400,
};

export const HYPOTHESIS: Hypothesis = {
  title: "Regressão do decoder no webOS 6.0",
  component: "Player",
  confidence: 78,
  summary:
    "O buffer ratio da Youbora sobe 6,1x minutos após o deploy 4.2.1, concentrado em TVs LG com webOS 6.0. A Tsuru registra o mesmo recorte com 6 minutos de defasagem, e o componente Player concentra os erros do incidente.",
};

export const CONCENTRATION: ConcentrationSlice[] = [
  { label: "webOS 6.0", percentage: 80 },
  { label: "App 4.2.1", percentage: 71 },
  { label: "LG OLED55", percentage: 68 },
  { label: "Nordeste", percentage: 52 },
];

export const CONCENTRATION_NOTE =
  "Recorte combinado explica 64% das falhas";

/** Evidências agrupadas por fonte, com detalhe expansível (US-N1-03). */
export const EVIDENCE_SOURCES: EvidenceSource[] = [
  {
    id: "youbora",
    source: "Youbora",
    summary: "falhas +312% · buffer 6,1x",
    strength: "forte",
    detail:
      "Métrica buffer_ratio, recorte LG webOS 6.0 · App 4.2.1. Amostra de 12,4 mil sessões, atualizada há 2 min.",
  },
  {
    id: "tsuru",
    source: "Tsuru",
    summary: "deploy 4.2.1 · diferença de 6 min",
    strength: "forte",
    detail:
      "Marco de deploy 4.2.1 às 09:12, 6 minutos antes do início da subida do buffer ratio na Youbora.",
  },
  {
    id: "apollo",
    source: "Apollo",
    summary: "p99 e erros dentro da linha de base",
    strength: "neutra",
    detail:
      "Latência p99 e taxa de erro do backend seguem estáveis no mesmo recorte. Amostra parcial, com 4 min de atraso na ingestão.",
  },
  {
    id: "rpaas-cdn",
    source: "RPaaS/CDN",
    summary: "sem variação de erro de borda",
    strength: "contra",
    detail:
      "Taxa de erro 4xx/5xx e cache hit ratio da CDN seguem estáveis, sem indício de degradação de borda no recorte afetado.",
  },
];

/** Marcos correlacionados no mesmo recorte, em ordem cronológica. */
export const TIMELINE: TimelineMark[] = [
  { time: "09:12", label: "Deploy 4.2.1", source: "Tsuru · Player", tone: "info" },
  { time: "09:18", label: "Buffer sobe", source: "Youbora", tone: "warning" },
  {
    time: "09:23",
    label: "Segmento detectado",
    source: "webOS 6.0 · NE",
    tone: "critical",
  },
  { time: "09:30", label: "Decoder +18x", source: "Player", tone: "critical" },
  { time: "09:34", label: "Incidente criado", source: "ServiceNow", tone: "info" },
  { time: "09:41", label: "Hipótese 78%", source: "Player · decoder", tone: "navy" },
];

export const CHANGE_LIKELIHOODS: ChangeLikelihood[] = [
  { label: "Provável", cause: "regressão do decoder", percentage: 78, tone: "critical" },
  { label: "Possível", cause: "degradação de CDN", percentage: 14, tone: "warning" },
  { label: "Possível", cause: "regressão do app", percentage: 8, tone: "info" },
];

export type WindowKey = "90" | "180" | "360";

export const WINDOW_LABELS: Record<WindowKey, string> = {
  "90": "Janela 90 min",
  "180": "Janela 3 h",
  "360": "Janela 6 h",
};

/* ========================= Buffering após a versão ========================= */

export type BufferingPoint = {
  time: string;
  value: number;
};

export type BufferingPeriodKey = "60" | "120" | "360";

export const BUFFERING_PERIOD_LABELS: Record<BufferingPeriodKey, string> = {
  "60": "Última hora",
  "120": "Últimas 2 horas",
  "360": "Últimas 6 horas",
};

/** Série de exemplo, com o mesmo salto do protótipo de alta fidelidade. */
export const BUFFERING_DATASETS: Record<BufferingPeriodKey, BufferingPoint[]> = {
  "60": [
    { time: "09:10", value: 1.6 },
    { time: "09:20", value: 1.9 },
    { time: "09:30", value: 2.6 },
    { time: "09:40", value: 3.9 },
    { time: "09:50", value: 4.9 },
    { time: "10:00", value: 4.2 },
  ],
  "120": [
    { time: "08:30", value: 0.8 },
    { time: "08:50", value: 1.0 },
    { time: "09:10", value: 1.6 },
    { time: "09:30", value: 2.6 },
    { time: "09:50", value: 4.9 },
    { time: "10:10", value: 3.8 },
  ],
  "360": [
    { time: "05:10", value: 0.6 },
    { time: "06:10", value: 0.7 },
    { time: "07:10", value: 0.9 },
    { time: "08:10", value: 1.1 },
    { time: "09:10", value: 1.6 },
    { time: "09:50", value: 4.9 },
    { time: "10:50", value: 3.1 },
  ],
};

/** Índice do ponto de deploy em cada janela, para a linha tracejada. */
export const DEPLOY_INDEX: Record<BufferingPeriodKey, number> = {
  "60": 2,
  "120": 3,
  "360": 5,
};

export const DEPLOY_LABEL = "Deploy 4.2.1";

/**
 * @file evidence-data.ts
 * Tipos do diagnóstico de um incidente: resumo, hipótese, evidências por
 * fonte, séries e linha do tempo.
 *
 * O conjunto de exemplo que morava aqui saiu: a tela nunca o usava (o
 * diagnóstico não tem dado de exemplo, por contrato) e ele só servia para
 * divergir do que a API realmente devolve.
 */

import type { BadgeTone } from "@/components/ui/badge";

export type IncidentSummary = {
  /** Identificador interno, usado nas rotas e nas chamadas à API. */
  id: string;
  /** Número legível (`INC-E2E-0044`), quando a origem publica. */
  number: string | null;
  title: string;
  startedAt: string;
  startedMinutesAgo: number;
  /** Prioridade da API: P1 a P4. */
  severity: string;
  /** Estado da API (`investigating`...), traduzido na tela. */
  investigationStatus: string;
  /**
   * Dispositivos, não sessões: é o que a API operacional conta. O rótulo da
   * tela acompanha, para que o número não afirme uma medição que não existe.
   */
  affectedDevices: number | null;
  component: string | null;
};

export type DiagnosisStatus =
  | "not_started"
  | "processing"
  | "ready"
  | "inconclusive"
  | "failed";

export const DIAGNOSIS_STATUS_LABELS: Record<DiagnosisStatus, string> = {
  not_started: "Diagnóstico não iniciado",
  processing: "Diagnóstico em andamento",
  ready: "Diagnóstico pronto",
  inconclusive: "Diagnóstico inconclusivo",
  failed: "Diagnóstico falhou",
};

export type Hypothesis = {
  title: string;
  component: string;
  /** Percentual de 0 a 100, ou `null` quando a origem não mediu. */
  confidence: number | null;
  summary: string;
};

export type ConcentrationSlice = {
  label: string;
  percentage: number;
};

/** Como a evidência se relaciona com a hipótese principal. */
export type EvidenceRelation = "supports" | "contradicts" | "context";

export const RELATION_META: Record<
  EvidenceRelation,
  { label: string; filterLabel: string; tone: BadgeTone }
> = {
  supports: { label: "Sustenta", filterLabel: "Sustentam", tone: "critical" },
  contradicts: { label: "Contradiz", filterLabel: "Contradizem", tone: "success" },
  context: { label: "Contexto", filterLabel: "Contexto", tone: "neutral" },
};

/** Força da evidência, como a API a publica. */
export type EvidenceStrength = "strong" | "moderate" | "weak";

export const STRENGTH_LABELS: Record<EvidenceStrength, string> = {
  strong: "forte",
  moderate: "moderada",
  weak: "fraca",
};

export type EvidenceField = { label: string; value: string };

export type EvidenceSource = {
  id: string;
  eventId: string;
  incidentId: string;
  observedAt: string | null;
  qualityStatus: string;
  qualityFlags: string[];
  /** Nome da fonte (`Argus`). */
  source: string;
  /** Conjunto de dados de origem (`live_qoe_hourly`). */
  dataset: string;
  /** Tipo da evidência na API (`metric`, `event`...). */
  type: string;
  relation: EvidenceRelation;
  strength: EvidenceStrength;
  /** Linha curta que diferencia uma evidência da outra na lista. */
  summary: string;
  /** Campos do detalhe expansível, um por linha. */
  fields: EvidenceField[];
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
  timestamp?: string;
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

export type BufferingPoint = {
  time: string;
  value: number;
};

export type BufferingSeries = {
  points: BufferingPoint[];
  marker: { index: number; label: string } | null;
};

/** Tudo o que a tela de diagnóstico desenha em uma leitura. */
export type EvidenceData = {
  incidentId: string;
  incident: IncidentSummary;
  diagnosisStatus: DiagnosisStatus;
  /** `null` enquanto o incidente não passou por diagnóstico. */
  hypothesis: Hypothesis | null;
  /** O que a API tem registrado sobre a revisão, na hora da leitura. */
  reviewStatus: ReviewStatus;
  concentration: ConcentrationSlice[];
  concentrationNote: string;
  sources: EvidenceSource[];
  /** `null` quando a origem não publicou a série para o incidente. */
  buffering: BufferingSeries | null;
  timeline: TimelineMark[];
  changes: ChangeLikelihood[];
};

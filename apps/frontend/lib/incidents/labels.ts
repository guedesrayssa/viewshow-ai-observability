/**
 * @file labels.ts
 * Vocabulário de incidente compartilhado pelas telas.
 *
 * A API responde os estados em inglês (`investigating`, `resolved`...). A
 * tradução mora aqui para que Visão Geral, Incidentes e o detalhe digam a
 * mesma coisa sobre o mesmo incidente.
 */

import type { BadgeTone } from "@/components/ui/badge";

export type IncidentStatus =
  | "detected"
  | "investigating"
  | "confirmed"
  | "resolved"
  | "closed";

export const INCIDENT_STATUS_META: Record<
  IncidentStatus,
  { label: string; tone: BadgeTone }
> = {
  detected: { label: "Detectado", tone: "warning" },
  investigating: { label: "Em investigação", tone: "info" },
  confirmed: { label: "Confirmado", tone: "critical" },
  resolved: { label: "Resolvido", tone: "success" },
  closed: { label: "Encerrado", tone: "neutral" },
};

/** Rótulo do estado; valores fora do contrato aparecem como vieram. */
export function incidentStatusLabel(status: string): string {
  return INCIDENT_STATUS_META[status as IncidentStatus]?.label ?? status;
}

export function incidentStatusTone(status: string): BadgeTone {
  return INCIDENT_STATUS_META[status as IncidentStatus]?.tone ?? "neutral";
}

export type Priority = "P1" | "P2" | "P3" | "P4";

export const PRIORITY_META: Record<
  Priority,
  { label: string; tone: BadgeTone }
> = {
  P1: { label: "P1 Crítico", tone: "critical" },
  P2: { label: "P2 Alto", tone: "warning" },
  P3: { label: "P3 Médio", tone: "info" },
  P4: { label: "P4 Baixo", tone: "success" },
};

export function priorityLabel(priority: string): string {
  return PRIORITY_META[priority as Priority]?.label ?? priority;
}

export function priorityTone(priority: string): BadgeTone {
  return PRIORITY_META[priority as Priority]?.tone ?? "neutral";
}

/**
 * Nome com que o incidente aparece na tela.
 *
 * O identificador interno (`inc_x7ev...`) é da API, não da pessoa: o número
 * (`INC-E2E-0044`) vem primeiro, e o id só aparece quando não há número.
 */
export function incidentCode(incident: { id: string; number?: string | null }): string {
  return incident.number?.trim() || incident.id;
}

/**
 * Título a exibir ao lado do código. Vazio quando a origem repete o número
 * no título, para a linha não dizer a mesma coisa duas vezes.
 */
export function incidentHeadline(incident: {
  id: string;
  number?: string | null;
  title: string;
}): string {
  const code = incidentCode(incident);
  return incident.title.trim() === code ? "" : incident.title;
}

/**
 * @file incident-mapping.ts
 * Conversão do incidente da API operacional para o cartão da Visão Geral.
 *
 * Fica separado porque duas leituras da tela precisam da mesma conversão: o
 * resumo (`summary-resource.ts`, via `/dashboard/summary`) e — enquanto
 * existir — a lista secundária de `overview-resource.ts`. Ter a regra em um
 * lugar só evita que `pk`, `sk` e `ttl` vazem para a tela por uma das vias e
 * não pela outra.
 */

import { type IncidentData } from "@/lib/dashboard-data";
import { formatCompact } from "@/lib/format";

/** Incidente como a API operacional o devolve hoje. */
export type IncidentResponse = {
  id: string;
  title: string;
  sessions?: string;
  timeAgo?: string;
  status?: string;
  statusLabel?: string;
  devices?: number;
  startedMinutesAgo?: number;
};

/**
 * Remove repetições do mesmo incidente, ficando com a ocorrência mais recente.
 * Execuções distintas do seed gravaram o mesmo `id` em baldes de horas
 * diferentes, e a rota devolve todos.
 */
export function dedupeById(incidents: IncidentResponse[]): IncidentResponse[] {
  const byId = new Map<string, IncidentResponse>();

  for (const incident of incidents) {
    const current = byId.get(incident.id);
    if (
      !current ||
      (incident.startedMinutesAgo ?? Infinity) <
        (current.startedMinutesAgo ?? Infinity)
    ) {
      byId.set(incident.id, incident);
    }
  }

  return [...byId.values()];
}

/** Tons de incidente que a Visão Geral sabe desenhar. */
const INCIDENT_STATUSES = new Set(["critical", "warning", "success", "info"]);

/**
 * Projeta o incidente da API no que o cartão da Visão Geral desenha.
 *
 * A rota devolve o item como ele está guardado, com as chaves físicas da
 * tabela junto. Copiar campo a campo é o que impede `pk`, `sk` e `ttl` de
 * chegarem à tela.
 */
export function toIncidentCard(incident: IncidentResponse): IncidentData {
  const status = INCIDENT_STATUSES.has(incident.status ?? "")
    ? (incident.status as IncidentData["status"])
    : "info";

  return {
    id: incident.id,
    title: incident.title,
    sessions:
      incident.sessions ??
      (incident.devices === undefined
        ? "sem contagem"
        : `${formatCompact(incident.devices)} dispositivos`),
    timeAgo:
      incident.timeAgo ??
      (incident.startedMinutesAgo === undefined
        ? ""
        : `há ${incident.startedMinutesAgo} min`),
    status,
    statusLabel: incident.statusLabel ?? "Ativo",
  };
}

/**
 * @file routes.ts
 * Endereços das telas do painel.
 *
 * O incidente é o eixo da investigação: diagnóstico e eventos correlacionados
 * são abas do detalhe dele, e não telas soltas. Como o painel é exportado como
 * HTML estático, o incidente vai na query string (`?incidente=`) em vez de um
 * segmento dinâmico, que exigiria conhecer todos os ids no build.
 */

export const ROUTES = {
  overview: "/visao-geral",
  incidents: "/incidentes",
  eventsFeed: "/incidentes/feed-eventos",
  incidentDetail: "/incidentes/detalhe",
  incidentEvents: "/incidentes/detalhe/eventos",
  incidentTimeline: "/incidentes/detalhe/linha-do-tempo",
  monitoring: "/monitoramento",
  imports: "/dados/importacoes",
  settings: "/configuracoes",
} as const;

function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** Diagnóstico (hipótese e evidências) de um incidente. */
export function incidentDiagnosisHref(incidentId: string): string {
  return withQuery(ROUTES.incidentDetail, { incidente: incidentId });
}

/** Eventos correlacionados a um incidente, opcionalmente com um evento aberto. */
export function incidentEventsHref(incidentId: string, eventId?: string | null): string {
  return withQuery(ROUTES.incidentEvents, { incidente: incidentId, evento: eventId });
}

/** Linha do tempo (marcos e mudanças correlacionadas) de um incidente. */
export function incidentTimelineHref(incidentId: string): string {
  return withQuery(ROUTES.incidentTimeline, { incidente: incidentId });
}

/**
 * Lista de incidentes aberta num período. A Visão Geral mostra incidentes além
 * das últimas 24 horas; "Ver todos" precisa abrir a lista num período que os
 * inclua, senão eles somem no clique.
 */
export function incidentsHref(period?: string | null): string {
  return withQuery(ROUTES.incidents, { periodo: period });
}

/** Feed global de eventos, com um evento aberto quando informado. */
export function eventsFeedHref(eventId?: string | null): string {
  return withQuery(ROUTES.eventsFeed, { evento: eventId });
}

/** Remove a barra final que a exportação estática acrescenta às rotas. */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * @file incidents-section-tabs.tsx
 * Abas da seção Incidentes: a lista priorizada e o feed global de eventos.
 *
 * O feed global (inclusive eventos ainda sem incidente) saiu da navegação
 * lateral e mora aqui, ao lado da lista: é a mesma investigação vista antes da
 * correlação.
 */

"use client";

import { TabLinks } from "@/components/navigation/tab-links";
import { ROUTES } from "@/lib/routes";

export function IncidentsSectionTabs() {
  return (
    <TabLinks
      label="Visões de Incidentes"
      tabs={[
        { label: "Incidentes", path: ROUTES.incidents, href: ROUTES.incidents },
        {
          label: "Feed de eventos",
          path: ROUTES.eventsFeed,
          href: ROUTES.eventsFeed,
        },
      ]}
    />
  );
}

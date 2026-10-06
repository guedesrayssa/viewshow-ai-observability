/**
 * page.tsx
 * Endereço antigo da tela de Eventos.
 *
 * Com incidente, os eventos são a aba "Eventos correlacionados" do detalhe
 * dele; sem, o feed global da seção Incidentes. Esta rota só redireciona,
 * para que links antigos não quebrem.
 */

"use client";

import { Suspense } from "react";

import { RouteRedirect } from "@/components/navigation/route-redirect";
import { Skeleton } from "@/components/ui/skeleton";
import { eventsFeedHref, incidentEventsHref } from "@/lib/routes";

function resolve(params: URLSearchParams): string {
  const incidentId = params.get("incidente");
  const eventId = params.get("evento");
  return incidentId ? incidentEventsHref(incidentId, eventId) : eventsFeedHref(eventId);
}

export default function LegacyEventsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <RouteRedirect resolve={resolve} />
    </Suspense>
  );
}

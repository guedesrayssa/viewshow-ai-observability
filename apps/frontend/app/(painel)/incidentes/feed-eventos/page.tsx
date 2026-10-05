/**
 * page.tsx
 * Feed global de eventos, na seção Incidentes.
 *
 * Mostra todos os eventos ARGUS, inclusive os ainda não correlacionados a um
 * incidente. Saiu da navegação lateral: é a investigação vista antes da
 * correlação, e mora ao lado da lista de incidentes.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { EventsView } from "@/app/(painel)/incidentes/_eventos/events-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Feed de eventos",
  description:
    "Eventos e sessões de telemetria do Globoplay, correlacionados ou não a incidentes, com o dado normalizado ligado à fonte original.",
};

export default function EventsFeedPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EventsView mode="feed" />
    </Suspense>
  );
}

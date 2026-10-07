/**
 * page.tsx
 * Detalhe de um incidente, aba Eventos correlacionados.
 *
 * Permite inspecionar os eventos de telemetria correlacionados ao incidente e
 * reconstruir seu contexto técnico, conforme a seção 5.5 do entendimento de
 * UX. Materializa principalmente a US-ENG-02 e a US-ENG-03.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { EventsView } from "@/app/(painel)/incidentes/_eventos/events-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Eventos do incidente",
  description:
    "Eventos de telemetria correlacionados a um incidente do Globoplay, com o dado normalizado ligado à fonte original.",
};

export default function IncidentEventsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EventsView mode="incident" />
    </Suspense>
  );
}

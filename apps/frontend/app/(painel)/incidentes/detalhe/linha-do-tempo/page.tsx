/**
 * page.tsx
 * Detalhe de um incidente, aba Linha do tempo.
 *
 * Marcos correlacionados ao incidente e mudanças que podem ter impactado,
 * na ordem em que aconteceram.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { TimelineView } from "@/app/(painel)/incidentes/detalhe/timeline-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Linha do tempo do incidente",
  description:
    "Marcos e mudanças correlacionadas a um incidente do Globoplay, em ordem cronológica.",
};

export default function IncidentTimelinePage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TimelineView />
    </Suspense>
  );
}

/**
 * page.tsx
 * Endereço antigo da tela de Evidências.
 *
 * O diagnóstico agora é a aba principal do detalhe do incidente
 * (`/incidentes/detalhe?incidente=`). Esta rota só redireciona, para que links
 * antigos não quebrem.
 */

"use client";

import { Suspense } from "react";

import { RouteRedirect } from "@/components/navigation/route-redirect";
import { Skeleton } from "@/components/ui/skeleton";
import { incidentDiagnosisHref, ROUTES } from "@/lib/routes";

function resolve(params: URLSearchParams): string {
  const incidentId = params.get("incidente");
  return incidentId ? incidentDiagnosisHref(incidentId) : ROUTES.incidents;
}

export default function LegacyEvidencePage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <RouteRedirect resolve={resolve} />
    </Suspense>
  );
}

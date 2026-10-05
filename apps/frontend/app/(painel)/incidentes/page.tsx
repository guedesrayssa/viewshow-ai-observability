/**
 * page.tsx
 * Tela de Incidentes do View Show.
 *
 * Reúne e ordena os incidentes que exigem atenção, para facilitar a escolha
 * da ocorrência a ser investigada, conforme a seção 5.3 do entendimento de
 * UX. Materializa principalmente a US-N1-01 e a US-N1-04. Cada incidente abre
 * o próprio detalhe, com o diagnóstico e os eventos correlacionados.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { IncidentsView } from "@/app/(painel)/incidentes/incidents-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Incidentes",
  description:
    "Incidentes e degradações detectados no Globoplay, ordenados por urgência, dispositivos impactados e recência.",
};

export default function IncidentsPage() {
  return (
    // Filtros e página vêm da URL: sem o limite de suspensão, a rota inteira
    // sairia da renderização estática.
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <IncidentsView />
    </Suspense>
  );
}

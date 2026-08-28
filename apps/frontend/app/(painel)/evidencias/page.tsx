/**
 * page.tsx
 * Tela de Evidências do View Show.
 *
 * Apresenta a hipótese de causa provável de um incidente e organiza as
 * evidências que sustentam o diagnóstico, conforme a seção 5.4 do
 * entendimento de UX. Materializa as US-N1-02 a US-N1-05, US-ENG-01 e
 * US-ENG-04.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { EvidenceView } from "@/app/(painel)/evidencias/evidence-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Evidências",
  description:
    "Hipótese de causa provável e evidências que sustentam o diagnóstico de um incidente do Globoplay.",
};

export default function EvidenciasPage() {
  return (
    // A tela lê o incidente investigado da URL, e por isso precisa de um limite
    // de suspensão: sem ele, a rota inteira sairia da renderização estática.
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EvidenceView />
    </Suspense>
  );
}

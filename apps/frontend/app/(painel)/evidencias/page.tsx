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

import { EvidenceView } from "@/app/(painel)/evidencias/evidence-view";

export const metadata: Metadata = {
  title: "Evidências",
  description:
    "Hipótese de causa provável e evidências que sustentam o diagnóstico de um incidente do Globoplay.",
};

export default function EvidenciasPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Evidências</h1>
        <p className="mt-1 text-body-sm text-brand-blue">
          Hipótese de causa provável e evidências do diagnóstico
        </p>
      </header>

      <EvidenceView />
    </div>
  );
}

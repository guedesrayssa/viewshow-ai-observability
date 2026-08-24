/**
 * page.tsx
 * Tela de Monitoramento da telemetria do View Show.
 *
 * Acompanha a saúde do pipeline de telemetria, a qualidade das fontes e a
 * distribuição geográfica das instabilidades, conforme a seção 5.6 do
 * entendimento de UX. Apoia as US-ENG-04, US-ENG-05 e US-PM-02 a US-PM-05.
 */

import type { Metadata } from "next";

import { MonitoringView } from "@/app/(painel)/monitoramento/monitoring-view";

export const metadata: Metadata = {
  title: "Monitoramento",
  description:
    "Saúde do pipeline de telemetria do Globoplay: ingestão, latência de processamento, fila, qualidade das fontes e concentração geográfica das instabilidades.",
};

export default function MonitoramentoPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Monitoramento</h1>
        <p className="mt-1 text-body-sm text-brand-blue">
          Saúde técnica, distribuição e concentração geográfica
        </p>
      </header>

      <MonitoringView />
    </div>
  );
}

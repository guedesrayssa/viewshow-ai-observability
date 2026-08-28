/**
 * page.tsx
 * Tela de Incidentes do View Show.
 *
 * Reúne e ordena os incidentes que exigem atenção, para facilitar a escolha
 * da ocorrência a ser investigada, conforme a seção 5.3 do entendimento de
 * UX. Materializa principalmente a US-N1-01 e a US-N1-04.
 */

import type { Metadata } from "next";

import { IncidentsView } from "@/app/(painel)/incidentes/incidents-view";

export const metadata: Metadata = {
  title: "Incidentes",
  description:
    "Incidentes e degradações detectados no Globoplay, ordenados por urgência, dispositivos impactados e recência.",
};

export default function IncidentsPage() {
  return <IncidentsView />;
}

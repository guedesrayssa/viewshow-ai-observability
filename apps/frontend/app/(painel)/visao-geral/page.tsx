/**
 * page.tsx
 * Tela de Visão Geral: hub do painel, com o estado do ecossistema em tempo
 * quase real (reprodução da prancha "01 Protótipo - Visão Geral").
 */

import type { Metadata } from "next";

import { OverviewView } from "@/app/(painel)/visao-geral/overview-view";

export const metadata: Metadata = {
  title: "Visão Geral",
  description:
    "Estado do ecossistema do Globoplay em tempo quase real: taxa de erros, latência, sessões afetadas e incidentes priorizados.",
};

export default function VisaoGeralPage() {
  return <OverviewView />;
}

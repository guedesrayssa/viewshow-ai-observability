/**
 * page.tsx
 * Tela de Dados: importações de dumps do ARGUS e a sincronização contínua
 * com ele.
 *
 * A sincronização morava em Configurações, entre as preferências da conta,
 * mas controla a ingestão da plataforma inteira: pertence ao mesmo lugar que
 * as importações, que também decidem que dado o painel mostra.
 */

import type { Metadata } from "next";

import { ImportsView } from "@/app/(painel)/dados/importacoes/imports-view";
import { Reveal } from "@/components/motion/reveal";
import { ArgusSyncCard } from "@/components/settings/argus-sync-card";

export const metadata: Metadata = {
  title: "Importações",
  description:
    "Envio e acompanhamento compartilhado de dumps do ARGUS e sincronização contínua com a origem.",
};

export default function ImportacoesPage() {
  return (
    <div className="flex flex-col gap-6">
      <ImportsView />
      <Reveal delay={200}>
        <ArgusSyncCard />
      </Reveal>
    </div>
  );
}

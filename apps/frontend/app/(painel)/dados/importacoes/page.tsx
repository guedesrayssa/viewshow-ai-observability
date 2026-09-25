import type { Metadata } from "next";

import { ImportsView } from "@/app/(painel)/dados/importacoes/imports-view";

export const metadata: Metadata = {
  title: "Importações",
  description: "Envio e acompanhamento compartilhado de dumps do ARGUS.",
};

export default function ImportacoesPage() {
  return <ImportsView />;
}

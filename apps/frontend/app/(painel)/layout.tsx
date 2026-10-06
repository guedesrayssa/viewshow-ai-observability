/**
 * layout.tsx
 * Moldura das telas autenticadas (Visão Geral, Incidentes com o detalhe de
 * cada incidente, Monitoramento, Dados e Configurações).
 *
 * A navegação lateral persistente descrita na seção 4.1 do entendimento de UX
 * fica fixa e pode ser recolhida; as ações de aparência, configurações e conta
 * vivem na barra superior, também fixa. Toda a montagem está em
 * `components/shell/app-shell.tsx`, que precisa de estado e por isso roda no
 * cliente.
 *
 * `PanelGuard` fica por fora: sem sessão (e fora do modo de demonstração),
 * ninguém vê nem a casca do painel — ver `components/shell/panel-guard.tsx`.
 *
 * O provider de importações fica aqui para um envio em andamento sobreviver à
 * troca de tela, mas em modo `lazy`: só lista as importações quando a tela
 * de Dados abre.
 */

import type { ReactNode } from "react";

import { ImportUploadProvider } from "@/components/imports/import-upload-provider";
import { AppShell } from "@/components/shell/app-shell";
import { PanelGuard } from "@/components/shell/panel-guard";

export default function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <PanelGuard>
      <ImportUploadProvider lazy>
        <AppShell>{children}</AppShell>
      </ImportUploadProvider>
    </PanelGuard>
  );
}

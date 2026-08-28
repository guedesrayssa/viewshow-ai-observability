/**
 * layout.tsx
 * Moldura das telas autenticadas (Visão Geral, Incidentes, Evidências,
 * Eventos, Monitoramento e Configurações).
 *
 * A navegação lateral persistente descrita na seção 4.1 do entendimento de UX
 * fica fixa e pode ser recolhida; as ações de aparência, configurações e conta
 * vivem na barra superior, também fixa. Toda a montagem está em
 * `components/shell/app-shell.tsx`, que precisa de estado e por isso roda no
 * cliente.
 */

import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";

export default function PainelLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

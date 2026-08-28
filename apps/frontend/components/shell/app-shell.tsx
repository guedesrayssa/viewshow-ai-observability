/**
 * @file app-shell.tsx
 * Moldura das telas autenticadas.
 *
 * Reúne a navegação lateral fixa, a barra superior e a área de conteúdo. É
 * aqui que mora o estado da navegação: recolhida ou aberta no computador,
 * sobreposta ou fechada no celular.
 *
 * A barra lateral não rola com a página. O que rola é apenas a área de
 * conteúdo, e a barra superior fica grudada no topo dela — assim a navegação e
 * as ações de conta continuam ao alcance em telas longas, como a de
 * Monitoramento.
 */

"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { useMediaQuery } from "@/hooks/use-media-query";
import { createPersistedPreference } from "@/lib/persisted-preference";

/**
 * Estado da navegação recolhida, guardado entre as sessões: quem fechou a
 * barra não quer encontrá-la aberta no próximo acesso.
 */
const navCollapsed = createPersistedPreference<"true" | "false">(
  "view-show:nav-collapsed",
  "false",
  (raw): raw is "true" | "false" => raw === "true" || raw === "false",
);

/** A partir daqui a navegação cabe ao lado do conteúdo (`lg` do Tailwind). */
const DESKTOP_QUERY = "(min-width: 64rem)";

export function AppShell({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(
    navCollapsed.subscribe,
    navCollapsed.getSnapshot,
    navCollapsed.getServerSnapshot,
  );

  // Recolher só existe no computador: em telas estreitas a barra é uma folha
  // sobreposta, onde uma faixa de ícones não economizaria espaço nenhum.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const collapsed = isDesktop && preference === "true";

  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    navCollapsed.set(navCollapsed.getSnapshot() === "true" ? "false" : "true");
  }, []);

  // Trocar de tela fecha a navegação sobreposta: mantê-la aberta esconderia
  // justamente o conteúdo que a pessoa acabou de pedir. Quem fecha é o clique
  // no item, em `SidebarNav`, e não um efeito observando a rota.
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    if (!mobileOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobile();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen, closeMobile]);

  return (
    <div className="flex min-h-full flex-1">
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />

      {/* `min-w-0` impede que uma tabela larga estique a coluna e empurre a
          navegação para fora da tela. */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        <Topbar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapsed={toggleCollapsed}
          onOpenMobile={() => setMobileOpen(true)}
        />

        <main className="flex-1 px-5 pb-10 pt-5 sm:px-7">{children}</main>
      </div>
    </div>
  );
}

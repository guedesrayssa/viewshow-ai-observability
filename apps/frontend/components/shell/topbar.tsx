/**
 * @file topbar.tsx
 * Barra superior das telas autenticadas.
 *
 * Fica grudada no topo da área de conteúdo com o que não pertence a nenhuma
 * tela em particular: abrir ou recolher a navegação, trocar a aparência e
 * chegar à conta. Configurações saiu daqui e virou item da navegação — é uma
 * tela como as outras, e ter dois caminhos para ela só dividia a atenção.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/app/(painel)/sidebar-nav";
import { useAccount } from "@/components/account/account-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Avatar } from "@/components/ui/avatar";
import {
  MenuIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
} from "@/components/ui/icons";
import { Wordmark } from "@/components/ui/wordmark";
import { cn } from "@/lib/cn";

/** Botão circular das ações do topo. */
const ACTION_CLASSES =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-pill border border-line bg-surface text-ink-muted transition-colors duration-200 hover:border-line-strong hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light";

export type TopbarProps = {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onOpenMobile: () => void;
};

export function Topbar({
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onOpenMobile,
}: TopbarProps) {
  const pathname = usePathname();
  const { profile } = useAccount();
  const current = NAV_ITEMS.find((item) => item.href === pathname);

  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex items-center gap-3 border-b border-line px-5 py-2.5 sm:px-7",
        // O leve véu deixa o conteúdo passar por baixo sem competir com a
        // barra, e mantém a leitura das ações durante a rolagem.
        "bg-canvas/85 backdrop-blur-md",
      )}
    >
      <button
        type="button"
        onClick={onOpenMobile}
        aria-controls="navegacao-principal"
        aria-expanded={mobileOpen}
        aria-label="Abrir navegação"
        className={cn(ACTION_CLASSES, "lg:hidden")}
      >
        <MenuIcon size={18} />
      </button>

      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-controls="navegacao-principal"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Abrir navegação" : "Recolher navegação"}
        title={collapsed ? "Abrir navegação" : "Recolher navegação"}
        className={cn(ACTION_CLASSES, "hidden lg:flex")}
      >
        {collapsed ? (
          <PanelExpandIcon size={18} />
        ) : (
          <PanelCollapseIcon size={18} />
        )}
      </button>

      {/* Com a navegação recolhida, a marca reaparece aqui para que a tela não
          fique sem assinatura. */}
      <Link
        href="/visao-geral"
        aria-label="View Show, ir para a Visão Geral"
        className={cn(
          "hidden rounded-field text-ink transition-opacity duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-blue-light",
          collapsed && "lg:block",
        )}
      >
        <Wordmark height={17} />
      </Link>

      <p className="truncate text-label text-ink-muted lg:hidden">
        {current?.label ?? "View Show"}
      </p>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle className={ACTION_CLASSES} />

        <Link
          href="/configuracoes"
          aria-label={`Conta de ${profile.name}`}
          title={profile.name}
          className="rounded-pill transition-transform duration-200 hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light"
        >
          <Avatar size="sm" />
        </Link>
      </div>
    </header>
  );
}

/**
 * @file sidebar.tsx
 * Navegação lateral das telas autenticadas.
 *
 * Fica fixa: a página rola por baixo dela. Tem dois tamanhos no computador —
 * aberta, com rótulos, e recolhida, só com ícones — e vira uma folha
 * sobreposta em telas estreitas, onde não há largura para mantê-la sempre
 * visível.
 *
 * Recolher é uma ação só, e ela mora na barra superior. Aqui dentro fica
 * apenas o botão de fechar da folha sobreposta, que existe porque em telas de
 * toque não há barra superior visível por trás dela.
 */

"use client";

import Link from "next/link";

import { SidebarNav } from "@/app/(painel)/sidebar-nav";
import { useAccount } from "@/components/account/account-provider";
import { Avatar } from "@/components/ui/avatar";
import { XIcon } from "@/components/ui/icons";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";
import { cn } from "@/lib/cn";

export type SidebarProps = {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

export function Sidebar({ collapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const { profile } = useAccount();

  return (
    <>
      {/* Véu da folha sobreposta. Fechar tocando fora é o gesto esperado em
          telas de toque. */}
      <div
        aria-hidden="true"
        onClick={onCloseMobile}
        className={cn(
          "fixed inset-0 z-40 bg-brand-navy-deep/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        id="navegacao-principal"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col justify-between bg-gradient-navy py-6",
          "transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          "lg:sticky lg:top-0 lg:bottom-auto lg:z-30 lg:h-dvh lg:translate-x-0",
          collapsed ? "lg:w-[4.5rem]" : "lg:w-60",
          // Em telas estreitas a barra tem sempre a largura cheia da folha,
          // independentemente do estado recolhido do computador.
          "w-60",
          mobileOpen ? "translate-x-0 shadow-raised" : "-translate-x-full",
        )}
      >
        <div className="flex flex-col gap-8">
          <div
            className={cn(
              "flex items-center gap-3",
              collapsed ? "justify-center px-2" : "px-4",
            )}
          >
            <Link
              href="/visao-geral"
              aria-label="View Show, ir para a Visão Geral"
              className="flex min-w-0 items-center gap-2.5 rounded-field text-ink-inverse focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-blue-light"
            >
              <LogoMark tone="gradient" size={collapsed ? 32 : 36} />
              {!collapsed ? <Wordmark height={26} /> : null}
            </Link>

            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Fechar navegação"
              className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-field text-gray-300 transition-colors duration-200 hover:bg-brand-navy-raised hover:text-ink-inverse focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light lg:hidden"
            >
              <XIcon size={18} />
            </button>
          </div>

          <SidebarNav collapsed={collapsed} onNavigate={onCloseMobile} />
        </div>

        <div className={collapsed ? "px-2" : "px-3"}>
          <Link
            href="/configuracoes"
            onClick={onCloseMobile}
            title={collapsed ? profile.name : undefined}
            className={cn(
              "flex items-center gap-3 rounded-field py-2.5 text-body-sm font-medium",
              "text-gray-300 transition-colors duration-200 hover:bg-brand-navy-raised hover:text-ink-inverse",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            <Avatar size="sm" />
            <span className={collapsed ? "sr-only" : "min-w-0"}>
              <span className="block truncate">{profile.name}</span>
              <span className="block truncate text-caption text-gray-400">
                Minha conta
              </span>
            </span>
          </Link>
        </div>
      </aside>
    </>
  );
}

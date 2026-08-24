/**
 * layout.tsx
 * Moldura das telas autenticadas (Visão Geral, Incidentes, Evidências,
 * Eventos e Monitoramento).
 *
 * Reproduz a navegação lateral persistente descrita na seção 4.1 do
 * entendimento de UX: fundo navy, marca no topo, itens de navegação e a
 * conta da pessoa usuária no rodapé. O conteúdo da tela ocupa o restante da
 * largura sobre o `canvas`, como nos protótipos de alta fidelidade. As ações
 * de tema escuro e configurações ficam fixas no canto superior direito, como
 * no protótipo, e se repetem em todas as telas desta moldura.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { MoonIcon, SettingsIcon, UserIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";
import { SidebarNav } from "@/app/(painel)/sidebar-nav";

/** Botão circular das ações do topo, sobre o fundo navy da marca. */
const TOP_ACTION_CLASSES =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-brand-navy text-ink-inverse transition-colors hover:bg-brand-navy-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light";

export default function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1">
      <aside className="flex w-64 shrink-0 flex-col justify-between bg-gradient-navy py-6">
        <div className="flex flex-col gap-8">
          <Logo tone="gradient" size={32} className="px-4 text-ink-inverse" />
          <SidebarNav />
        </div>

        <div className="px-3">
          <Link
            href="/configuracoes"
            className="flex items-center gap-3 rounded-field px-3 py-2.5 text-body-sm font-medium text-gray-300 transition-colors hover:bg-brand-navy-raised hover:text-ink-inverse"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-brand-navy-raised text-ink-inverse">
              <UserIcon size={18} />
            </span>
            Minha conta
          </Link>
        </div>
      </aside>

      <main className="relative flex-1 overflow-x-hidden bg-canvas px-8 py-8">
        <div className="absolute right-8 top-8 flex items-center gap-3">
          <button
            type="button"
            aria-label="Alternar tema escuro"
            className={TOP_ACTION_CLASSES}
          >
            <MoonIcon size={18} />
          </button>

          <Link
            href="/configuracoes"
            aria-label="Configurações"
            className={TOP_ACTION_CLASSES}
          >
            <SettingsIcon size={18} />
          </Link>
        </div>

        {children}
      </main>
    </div>
  );
}

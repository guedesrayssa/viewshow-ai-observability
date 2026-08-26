/**
 * @file sidebar-nav.tsx
 * Itens de navegação da barra lateral persistente.
 *
 * Reflete a IA descrita na seção 6.1 do entendimento de UX: Visão Geral é o
 * hub, e a pessoa usuária aprofunda a investigação em Incidentes, Evidências,
 * Eventos e Monitoramento. Configurações fecha a lista, separada por uma
 * divisória: é ajuste da conta, não etapa da investigação.
 *
 * O item ativo é decidido pela rota atual, por isso este trecho roda no
 * cliente enquanto o restante da moldura fica no servidor.
 *
 * Na faixa recolhida sobra apenas o ícone. O rótulo continua no DOM, para o
 * leitor de tela, e reaparece como dica ao passar o ponteiro.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import {
  ActivityIcon,
  AlertIcon,
  HomeIcon,
  ListIcon,
  MonitorIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  /** Abre um espaço acima do item, separando-o do grupo anterior. */
  startsGroup?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { label: "Visão Geral", href: "/visao-geral", icon: <HomeIcon size={19} /> },
  { label: "Incidentes", href: "/incidentes", icon: <AlertIcon size={19} /> },
  { label: "Evidências", href: "/evidencias", icon: <ListIcon size={19} /> },
  { label: "Eventos", href: "/eventos", icon: <ActivityIcon size={19} /> },
  {
    label: "Monitoramento",
    href: "/monitoramento",
    icon: <MonitorIcon size={19} />,
  },
  {
    label: "Configurações",
    href: "/configuracoes",
    icon: <SettingsIcon size={19} />,
    startsGroup: true,
  },
];

export type SidebarNavProps = {
  /** Recolhe os rótulos, deixando só os ícones. */
  collapsed?: boolean;
  /** Chamado ao navegar. A navegação em telas estreitas fecha a barra. */
  onNavigate?: () => void;
};

export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegação principal"
      className={cn("flex flex-col gap-1.5", collapsed ? "px-2" : "px-3")}
    >
      {NAV_ITEMS.map((item, index) => {
        const active = pathname === item.href;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            style={{ animationDelay: `${index * 45}ms` }}
            className={cn(
              "group relative flex animate-slide-in-left items-center gap-3 rounded-field py-3",
              "text-body-sm font-medium transition-colors duration-200",
              collapsed ? "justify-center px-0" : "px-3",
              // A divisória separa a investigação do ajuste de conta sem
              // precisar de um título de grupo.
              item.startsGroup && "mt-4 border-t border-brand-navy-line pt-5",
              active
                ? "bg-gradient-brand text-ink-inverse shadow-brand"
                : "text-gray-300 hover:bg-brand-navy-raised hover:text-ink-inverse",
            )}
          >
            <span className="shrink-0">{item.icon}</span>

            {/* O rótulo some da vista, nunca do DOM: a navegação recolhida
                continua legível para quem usa leitor de tela. */}
            <span
              className={cn(
                "whitespace-nowrap transition-[opacity,transform] duration-200",
                collapsed ? "sr-only" : "translate-x-0 opacity-100",
              )}
            >
              {item.label}
            </span>

            {collapsed ? (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-full z-30 ml-3 origin-left scale-95 rounded-field",
                  "bg-brand-navy-raised px-2.5 py-1.5 text-caption font-medium text-ink-inverse opacity-0 shadow-raised",
                  "transition-[opacity,transform] duration-150",
                  "group-hover:scale-100 group-hover:opacity-100",
                )}
              >
                {item.label}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

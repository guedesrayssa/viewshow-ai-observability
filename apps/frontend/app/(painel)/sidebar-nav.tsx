/**
 * @file sidebar-nav.tsx
 * Itens de navegação da barra lateral persistente.
 *
 * Visão Geral é o hub e Incidentes é onde a investigação acontece: o
 * diagnóstico (hipótese e evidências) e os eventos correlacionados são abas do
 * detalhe de um incidente, e não itens soltos daqui. Soltos, eles abriam sem o
 * incidente e perdiam o contexto a cada clique.
 *
 * Três grupos, separados por divisórias: a investigação (Visão Geral e
 * Incidentes), a operação da plataforma (Monitoramento, com a saúde do
 * pipeline, e Dados, com importações e a sincronização com o ARGUS) e a conta
 * pessoal (Configurações). Nenhum dos dois últimos é etapa da investigação.
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
import { Fragment, type ReactNode } from "react";

import {
  AlertIcon,
  DatabaseIcon,
  HomeIcon,
  MonitorIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { normalizePath, ROUTES } from "@/lib/routes";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  /** Abre um espaço acima do item, separando-o do grupo anterior. */
  startsGroup?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { label: "Visão Geral", href: ROUTES.overview, icon: <HomeIcon size={19} /> },
  { label: "Incidentes", href: ROUTES.incidents, icon: <AlertIcon size={19} /> },
  {
    label: "Monitoramento",
    href: ROUTES.monitoring,
    icon: <MonitorIcon size={19} />,
    startsGroup: true,
  },
  {
    label: "Dados",
    href: ROUTES.imports,
    icon: <DatabaseIcon size={19} />,
  },
  {
    label: "Configurações",
    href: ROUTES.settings,
    icon: <SettingsIcon size={19} />,
    startsGroup: true,
  },
];

/**
 * Item da navegação ao qual a rota pertence. Rotas internas da seção
 * (`/incidentes/detalhe/eventos/`) respondem pelo item da seção.
 */
export function navItemFor(pathname: string): NavItem | undefined {
  const currentPath = normalizePath(pathname);
  return NAV_ITEMS.find(
    (item) => currentPath === item.href || currentPath.startsWith(`${item.href}/`),
  );
}

export type SidebarNavProps = {
  /** Recolhe os rótulos, deixando só os ícones. */
  collapsed?: boolean;
  /** Chamado ao navegar. A navegação em telas estreitas fecha a barra. */
  onNavigate?: () => void;
};

export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
  const pathname = usePathname();
  // A exportação estática usa trailingSlash: a URL pode chegar com "/" no fim.
  // Rotas internas da seção também pertencem ao mesmo item da navegação.
  const activeHref = navItemFor(pathname)?.href;

  return (
    <nav
      aria-label="Navegação principal"
      className={cn("flex flex-col gap-1.5", collapsed ? "px-2" : "px-3")}
    >
      {NAV_ITEMS.map((item, index) => {
        const active = item.href === activeHref;

        return (
          <Fragment key={item.href}>
            {/* A divisória separa os grupos (investigação, operação e conta)
                sem precisar de um título. Ela é um elemento à parte, e não uma
                borda no próprio item: como borda, o espaço acima entrava na
                caixa do link e o realce ativo ficava mais alto que os demais. */}
            {item.startsGroup ? (
              <span
                aria-hidden="true"
                className={cn(
                  "my-2 h-px bg-brand-navy-line",
                  collapsed ? "mx-auto w-8" : "mx-3",
                )}
              />
            ) : null}

            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              style={{ animationDelay: `${index * 45}ms` }}
              className={cn(
                "group relative flex animate-slide-in-left items-center gap-3 rounded-field py-2.5",
                "text-body-sm font-medium transition-colors duration-200",
                // Recolhida, a caixa vira um quadrado do tamanho da altura da
                // linha: o ícone fica no centro do realce, e não à esquerda de
                // uma faixa larga.
                collapsed ? "mx-auto w-[2.375rem] justify-center px-0" : "px-3",
                active
                  ? "bg-gradient-brand text-ink-inverse shadow-brand"
                  : "text-gray-300 hover:bg-brand-navy-raised hover:text-ink-inverse",
              )}
            >
              {/* O ícone entra em uma caixa de tamanho fixo, centrado nos dois
                  eixos. Solto, o SVG é um elemento em linha e senta sobre a
                  base do texto, o que o deslocava para cima dentro do realce. */}
              <span className="flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center">
                {item.icon}
              </span>

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
          </Fragment>
        );
      })}
    </nav>
  );
}

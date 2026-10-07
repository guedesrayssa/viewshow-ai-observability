/**
 * @file tab-links.tsx
 * Abas que trocam de rota.
 *
 * Cada aba é um link de verdade: abre em nova guia, entra no histórico do
 * navegador e pode ser compartilhada. A aba ativa é decidida pela rota, como
 * na navegação lateral.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { normalizePath } from "@/lib/routes";

export type TabLink = {
  label: string;
  /** Rota da aba, sem query string. Decide qual aba está ativa. */
  path: string;
  /** Endereço completo do link, com a query string que a aba precisa. */
  href: string;
  badge?: ReactNode;
};

export function TabLinks({
  tabs,
  label,
  className,
}: {
  tabs: TabLink[];
  /** Nome do grupo de abas, para o leitor de tela. */
  label: string;
  className?: string;
}) {
  const current = normalizePath(usePathname());

  return (
    <nav aria-label={label} className={cn("border-b border-line", className)}>
      <ul className="-mb-px flex flex-wrap gap-1">
        {tabs.map((tab) => {
          const active = normalizePath(tab.path) === current;

          return (
            <li key={tab.path}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-ring inline-flex items-center gap-2 rounded-t-field border-b-2 px-4 py-2.5 text-body-sm font-medium transition-colors duration-200",
                  active
                    ? "border-brand-blue text-ink"
                    : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {tab.label}
                {tab.badge}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

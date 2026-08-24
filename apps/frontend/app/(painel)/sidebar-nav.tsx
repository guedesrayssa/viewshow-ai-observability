/**
 * @file sidebar-nav.tsx
 * Itens de navegação da barra lateral persistente.
 *
 * Reflete a IA descrita na seção 6.1 do entendimento de UX: Visão Geral é o
 * hub, e a pessoa usuária aprofunda a investigação em Incidentes, Evidências,
 * Eventos e Monitoramento. O item ativo é decidido pela rota atual, por isso
 * este trecho roda no cliente enquanto o restante da moldura fica no servidor.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import {
  ActivityIcon,
  HomeIcon,
  ListIcon,
  MonitorIcon,
} from "@/components/ui/icons";
import { AlertIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Visão Geral", href: "/visao-geral", icon: <HomeIcon size={20} /> },
  { label: "Incidentes", href: "/incidentes", icon: <AlertIcon size={20} /> },
  { label: "Evidências", href: "/evidencias", icon: <ListIcon size={20} /> },
  { label: "Eventos", href: "/eventos", icon: <ActivityIcon size={20} /> },
  {
    label: "Monitoramento",
    href: "/monitoramento",
    icon: <MonitorIcon size={20} />,
  },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-field px-3 py-2.5 text-body-sm font-medium transition-colors",
              active
                ? "bg-gradient-brand text-ink-inverse shadow-brand"
                : "text-gray-300 hover:bg-brand-navy-raised hover:text-ink-inverse",
            )}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

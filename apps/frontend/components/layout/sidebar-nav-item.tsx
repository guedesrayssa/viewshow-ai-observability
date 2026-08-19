"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ClipboardList,
  Home,
  Monitor,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavIconName, NavItem } from "@/lib/navigation";

const ICONS: Record<NavIconName, LucideIcon> = {
  home: Home,
  alert: TriangleAlert,
  clipboard: ClipboardList,
  activity: Activity,
  monitor: Monitor,
};

export function SidebarNavItem({ href, label, icon }: NavItem) {
  const pathname = usePathname();
  const isActive = pathname === href;
  const Icon = ICONS[icon];

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors",
        isActive
          ? "brand-gradient text-white"
          : "text-sidebar-fg-muted hover:bg-white/5 hover:text-white",
      )}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden />
      {label}
    </Link>
  );
}

export type NavIconName = "home" | "alert" | "clipboard" | "activity" | "monitor";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Visão Geral", icon: "home" },
  { href: "/incidentes", label: "Incidentes", icon: "alert" },
  { href: "/evidencias", label: "Evidências", icon: "clipboard" },
  { href: "/eventos", label: "Eventos", icon: "activity" },
  { href: "/monitoramento", label: "Monitoramento", icon: "monitor" },
];

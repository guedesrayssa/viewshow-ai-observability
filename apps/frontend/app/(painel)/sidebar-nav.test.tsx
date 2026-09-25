import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NAV_ITEMS, SidebarNav } from "./sidebar-nav";

const route = vi.hoisted(() => ({ pathname: "/visao-geral/" }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

describe("sidebar navigation", () => {
  beforeEach(() => {
    route.pathname = "/visao-geral/";
  });

  it("insere Dados antes de Configurações e move o início do grupo", () => {
    expect(NAV_ITEMS.slice(-3).map((item) => item.label)).toEqual([
      "Monitoramento",
      "Dados",
      "Configurações",
    ]);
    expect(NAV_ITEMS.find((item) => item.label === "Dados")).toMatchObject({
      href: "/dados/importacoes",
      startsGroup: true,
    });
    expect(
      NAV_ITEMS.find((item) => item.label === "Configurações")?.startsGroup,
    ).toBeUndefined();
  });

  it("marca Dados como página atual e mantém rótulo no modo recolhido", () => {
    route.pathname = "/dados/importacoes";
    render(<SidebarNav collapsed />);
    expect(screen.getByRole("link", { name: "Dados" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByText("Dados", { selector: "span:not([aria-hidden])" }),
    ).toBeInTheDocument();
  });

  it("destaca a aba atual quando a URL tem barra final", () => {
    render(<SidebarNav />);

    const overview = screen.getByRole("link", { name: "Visão Geral" });
    expect(overview).toHaveAttribute("aria-current", "page");
    expect(overview).toHaveClass("bg-gradient-brand");
    expect(screen.getByRole("link", { name: "Incidentes" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("acompanha a rota da seção em páginas internas", () => {
    route.pathname = "/incidentes/detalhes/123/";
    render(<SidebarNav />);

    expect(screen.getByRole("link", { name: "Incidentes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Visão Geral" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

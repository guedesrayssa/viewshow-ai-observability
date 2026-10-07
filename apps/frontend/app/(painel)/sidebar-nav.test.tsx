import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NAV_ITEMS, SidebarNav } from "./sidebar-nav";

const route = vi.hoisted(() => ({ pathname: "/visao-geral/" }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

describe("sidebar navigation", () => {
  beforeEach(() => {
    route.pathname = "/visao-geral/";
  });

  it("deixa a investigação em Incidentes e agrupa o operacional", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Visão Geral",
      "Incidentes",
      "Monitoramento",
      "Dados",
      "Configurações",
    ]);
    expect(
      NAV_ITEMS.find((item) => item.label === "Monitoramento"),
    ).toMatchObject({ href: "/monitoramento", startsGroup: true });
    expect(NAV_ITEMS.find((item) => item.label === "Dados")).toMatchObject({
      href: "/dados/importacoes",
    });
    expect(
      NAV_ITEMS.find((item) => item.label === "Dados")?.startsGroup,
    ).toBeUndefined();
    // A conta pessoal fica num grupo à parte do operacional.
    expect(
      NAV_ITEMS.find((item) => item.label === "Configurações"),
    ).toMatchObject({ href: "/configuracoes", startsGroup: true });
  });

  it("não oferece Evidências nem Eventos como itens soltos", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(labels).not.toContain("Evidências");
    expect(labels).not.toContain("Eventos");
  });

  it("marca Incidentes nas abas do detalhe e no feed de eventos", () => {
    for (const path of [
      "/incidentes/detalhe/",
      "/incidentes/detalhe/eventos/",
      "/incidentes/detalhe/linha-do-tempo/",
      "/incidentes/feed-eventos/",
    ]) {
      route.pathname = path;
      const { unmount } = render(<SidebarNav />);
      expect(screen.getByRole("link", { name: "Incidentes" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      unmount();
    }
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

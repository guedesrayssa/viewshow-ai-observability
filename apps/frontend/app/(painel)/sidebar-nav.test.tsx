import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarNav } from "./sidebar-nav";

const route = vi.hoisted(() => ({ pathname: "/visao-geral/" }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

describe("sidebar navigation", () => {
  beforeEach(() => {
    route.pathname = "/visao-geral/";
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

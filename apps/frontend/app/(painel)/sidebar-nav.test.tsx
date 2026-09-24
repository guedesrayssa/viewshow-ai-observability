import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { selectIncident, useSelectedIncidentId } from "@/lib/selected-incident";
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

  it("mantém o incidente escolhido ao navegar entre Evidências e Eventos", async () => {
    act(() => selectIncident("INC-4821"));
    const selection = renderHook(({ requestedId }) => useSelectedIncidentId(requestedId), {
      initialProps: { requestedId: "" },
    });

    expect(selection.result.current).toBe("INC-4821");
    selection.rerender({ requestedId: "INC-9300" });
    await waitFor(() => expect(window.localStorage.getItem("view-show:selected-incident")).toBe("INC-9300"));
    selection.unmount();

    const reopened = renderHook(() => useSelectedIncidentId());
    expect(reopened.result.current).toBe("INC-9300");

    render(<SidebarNav />);
    expect(screen.getByRole("link", { name: "Evidências" })).toHaveAttribute("href", "/evidencias?incidente=INC-9300");
    expect(screen.getByRole("link", { name: "Eventos" })).toHaveAttribute("href", "/eventos?incidente=INC-9300");
  });
});

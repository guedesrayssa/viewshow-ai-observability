import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IncidentsList } from "@/app/(painel)/incidentes/incidents-resource";
import type { Resource } from "@/lib/data/client";

const mockFetchIncidents = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/incidentes/",
  useSearchParams: () => new URLSearchParams(route.search),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/(painel)/incidentes/incidents-resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/(painel)/incidentes/incidents-resource")>()),
  fetchIncidents: mockFetchIncidents,
  fetchAffectedDevices: vi.fn(async () => ({
    data: [],
    source: "api",
    availability: "measured",
    warnings: [],
    fetchedAt: new Date(),
  })),
}));

import { IncidentsView } from "@/app/(painel)/incidentes/incidents-view";

function list(supportedDimensions: string[]): Resource<IncidentsList> {
  return {
    data: { items: [], hasMore: false, limit: 100, supportedDimensions },
    source: "api",
    availability: "measured",
    warnings: [],
    fetchedAt: new Date(),
  };
}

beforeEach(() => {
  mockFetchIncidents.mockReset();
  route.search = "";
});

describe("filtros de incidentes a partir das capacidades da API", () => {
  it("mostra só os filtros que a API declara recortar", async () => {
    mockFetchIncidents.mockResolvedValue(list(["priority", "status"]));
    render(<IncidentsView />);

    expect(await screen.findByText("Nenhum incidente encontrado")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filtrar por prioridade" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filtrar por estado" })).toBeInTheDocument();
  });

  it("esconde e deixa de enviar um filtro que a API não aceita", async () => {
    route.search = "estado=investigating";
    mockFetchIncidents.mockResolvedValue(list(["priority"]));
    render(<IncidentsView />);

    expect(await screen.findByText("Nenhum incidente encontrado")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Filtrar por estado" })).not.toBeInTheDocument();
    // A leitura seguinte sai sem o estado que a API não recorta.
    const lastQuery = mockFetchIncidents.mock.calls.at(-1)?.[0];
    expect(lastQuery).toMatchObject({ status: "all" });
  });
});

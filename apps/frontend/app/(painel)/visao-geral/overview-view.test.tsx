/** Decision states for the Visão Geral backed by one overview resource. */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OverviewData } from "@/app/(painel)/visao-geral/overview-resource";
import type { Resource } from "@/lib/data/client";
import type { Warning } from "@/lib/data/warnings";

const { mockFetchOverview } = vi.hoisted(() => ({
  mockFetchOverview: vi.fn(),
}));

vi.mock("@/app/(painel)/visao-geral/overview-resource", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchOverview: mockFetchOverview };
});

import { OverviewView } from "@/app/(painel)/visao-geral/overview-view";

const AT = new Date("2026-09-07T12:00:00Z");

function okResource<T>(data: T, over: Partial<Resource<T>> = {}): Resource<T> {
  return {
    data,
    source: "api",
    availability: "measured",
    warnings: [],
    fetchedAt: AT,
    ...over,
  };
}

function unavailableResource<T>(warnings: Warning[]): Resource<T> {
  return {
    source: "indisponivel",
    availability: "unavailable",
    warnings,
    fetchedAt: AT,
    fallbackReason: warnings[0]?.message,
  };
}

const pending = <T,>(): Promise<Resource<T>> =>
  new Promise<Resource<T>>(() => {});

const OVERVIEW: OverviewData = {
  stats: [
    {
      id: "affected-sessions",
      label: "Sessões afetadas",
      value: 12400,
      format: "compact",
      delta: "",
      accent: "info",
      deltaTone: "neutral",
    },
    {
      id: "active-incidents",
      label: "Incidentes ativos",
      value: 3,
      format: "integer",
      delta: "",
      accent: "warning",
      deltaTone: "neutral",
    },
    {
      id: "critical-incidents",
      label: "Incidentes críticos",
      value: 1,
      format: "integer",
      delta: "",
      accent: "critical",
      deltaTone: "neutral",
    },
  ],
  series: [
    { label: "09:00", value: 10 },
    { label: "09:15", value: 20 },
  ],
  baseline: 8,
  anomalyRange: null,
  peakIndex: 1,
  incidents: [
    {
      id: "inc-1",
      title: "Timeout de CDN no Nordeste",
      sessions: "2,1 mil sessões",
      timeAgo: "há 31 min",
      status: "warning",
      statusLabel: "investigating",
    },
  ],
};

const WARNING: Warning = {
  code: "READ_FAILED",
  message: "A projeção de overview não respondeu.",
};

beforeEach(() => {
  mockFetchOverview.mockReset();
});

describe("Visão Geral com uma fonte canônica", () => {
  it("shows placeholders while the overview is loading", () => {
    mockFetchOverview.mockReturnValue(pending());

    const { container } = render(<OverviewView />);

    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sessões afetadas")).not.toBeInTheDocument();
  });

  it("renders indicators, chart, and incidents from the same overview", async () => {
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    const { container } = render(<OverviewView />);

    expect(await screen.findByText("Sessões afetadas")).toBeInTheDocument();
    expect(screen.getByText("Incidentes críticos")).toBeInTheDocument();
    expect(screen.getByText("Timeout de CDN no Nordeste")).toBeInTheDocument();
    expect(screen.getByText("Saúde da experiência")).toBeInTheDocument();
    expect(
      screen.getByText("Eventos de erro observados por minuto, por intervalo"),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
    expect(mockFetchOverview).toHaveBeenCalledTimes(1);
  });

  it("marks every overview block unavailable when the canonical read fails", async () => {
    mockFetchOverview.mockResolvedValue(
      unavailableResource<OverviewData>([WARNING]),
    );

    const { container } = render(<OverviewView />);

    expect(
      await screen.findByText("Indicadores indisponíveis"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Saúde da experiência indisponível"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Incidentes recentes indisponíveis"),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
  });

  it("refreshes the single overview resource", async () => {
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));
    render(<OverviewView />);
    await screen.findByText("Sessões afetadas");

    await userEvent.click(
      screen.getByRole("button", { name: "Atualizar dados" }),
    );

    await waitFor(() => expect(mockFetchOverview).toHaveBeenCalledTimes(2));
  });

  it("reloads the whole overview with the selected period", async () => {
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));
    render(<OverviewView />);
    await screen.findByText("Sessões afetadas");

    await userEvent.click(screen.getByRole("combobox", { name: "Período" }));
    await userEvent.click(screen.getByRole("option", { name: "Última 1 h" }));

    await waitFor(() =>
      expect(mockFetchOverview).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeRange: "1h" }),
        expect.any(Number),
      ),
    );
  });
});

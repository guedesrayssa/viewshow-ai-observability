/**
 * @file overview-view.test.tsx
 * Lógica de decisão da Visão Geral: quando cada bloco mostra dado, espaço
 * reservado ou indisponível, e o que o cabeçalho declara quando as duas
 * leituras — resumo (operacional) e série (telemetria) — discordam.
 *
 * Só o limite de leitura é dublê: `fetchSummary` e `fetchOverview` viram
 * `vi.fn`. O `useResource` real roda, então os estados de carregando,
 * atualizando e falha são os de produção.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Resource } from "@/lib/data/client";
import type { Warning } from "@/lib/data/warnings";
import type { OverviewData } from "@/app/(painel)/visao-geral/overview-resource";
import type { SummaryData } from "@/app/(painel)/visao-geral/summary-resource";

const { mockFetchSummary, mockFetchOverview } = vi.hoisted(() => ({
  mockFetchSummary: vi.fn(),
  mockFetchOverview: vi.fn(),
}));

vi.mock("@/app/(painel)/visao-geral/summary-resource", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchSummary: mockFetchSummary };
});

vi.mock("@/app/(painel)/visao-geral/overview-resource", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchOverview: mockFetchOverview };
});

// Importado depois dos mocks porque consome as duas leituras.
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

const pending = <T,>(): Promise<Resource<T>> => new Promise<Resource<T>>(() => {});

const SUMMARY: SummaryData = {
  stats: [
    { id: "affected-sessions", label: "Sessões afetadas", value: 12400, format: "compact", delta: "", accent: "info", deltaTone: "neutral" },
    { id: "active-incidents", label: "Incidentes ativos", value: 3, format: "integer", delta: "", accent: "warning", deltaTone: "neutral" },
    { id: "critical-incidents", label: "Incidentes críticos", value: 1, format: "integer", delta: "", accent: "critical", deltaTone: "neutral" },
  ],
  incidents: [
    { id: "inc-1", title: "Timeout de CDN no Nordeste", sessions: "2,1 mil dispositivos", timeAgo: "há 31 min", status: "warning", statusLabel: "Atenção" },
  ],
};

const OVERVIEW: OverviewData = {
  series: [
    { label: "09:00", value: 0.01 },
    { label: "09:03", value: 0.02 },
  ],
  baseline: null,
  anomalyRange: null,
  peakIndex: 1,
};

const WARN_OP: Warning = { code: "OPERATIONAL_API_UNAVAILABLE", message: "A API de incidentes não respondeu." };
const WARN_TELE: Warning = { code: "READ_FAILED", message: "A telemetria não respondeu." };

beforeEach(() => {
  mockFetchSummary.mockReset();
  mockFetchOverview.mockReset();
});

describe("Visão Geral — carregando x pronto x indisponível", () => {
  it("mostra espaço reservado enquanto a leitura não termina", () => {
    mockFetchSummary.mockReturnValue(pending());
    mockFetchOverview.mockReturnValue(pending());

    const { container } = render(<OverviewView />);

    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sessões afetadas")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Indicadores de incidentes indisponíveis"),
    ).not.toBeInTheDocument();
  });

  it("mostra o conteúdo quando a leitura termina com dado", async () => {
    mockFetchSummary.mockResolvedValue(okResource(SUMMARY));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    const { container } = render(<OverviewView />);

    expect(await screen.findByText("Sessões afetadas")).toBeInTheDocument();
    expect(screen.getByText("Incidentes críticos")).toBeInTheDocument();
    expect(screen.getByText("Timeout de CDN no Nordeste")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos" })).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
  });

  it("mostra estado indisponível — não fica preso no espaço reservado — quando a leitura termina sem dado", async () => {
    mockFetchSummary.mockResolvedValue(unavailableResource<SummaryData>([WARN_OP]));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    const { container } = render(<OverviewView />);

    expect(
      await screen.findByText("Indicadores de incidentes indisponíveis"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Incidentes recentes indisponíveis"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sessões afetadas")).not.toBeInTheDocument();
    // O espaço reservado dos indicadores/incidentes não pode continuar na tela.
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
  });
});

describe("Visão Geral — Alert de indisponibilidade", () => {
  it("dispara quando o resumo não tem fonte, ainda que o status não seja de erro", async () => {
    mockFetchSummary.mockResolvedValue(unavailableResource<SummaryData>([WARN_OP]));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    render(<OverviewView />);

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível ler o resumo de incidentes");
  });

  it("usa a mensagem de warnings[0] quando não há erro próprio", async () => {
    mockFetchSummary.mockResolvedValue(unavailableResource<SummaryData>([WARN_OP]));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    render(<OverviewView />);

    const alerta = await screen.findByRole("alert");
    expect(within(alerta).getByText(/A API de incidentes não respondeu\./)).toBeInTheDocument();
    expect(alerta).toHaveTextContent("Tente atualizar em alguns instantes.");
  });
});

describe("Visão Geral — status e refresh combinam as duas leituras", () => {
  it("rebaixa o selo de 'ao vivo' para 'parcial' quando a telemetria falha e o resumo está medido", async () => {
    mockFetchSummary.mockResolvedValue(okResource(SUMMARY));
    mockFetchOverview.mockResolvedValue(unavailableResource<OverviewData>([WARN_TELE]));

    render(<OverviewView />);

    expect(await screen.findByText("Telemetria parcial")).toBeInTheDocument();
    expect(screen.queryByText("Telemetria ao vivo")).not.toBeInTheDocument();
  });

  it("mantém 'ao vivo' quando as duas leituras estão medidas", async () => {
    mockFetchSummary.mockResolvedValue(okResource(SUMMARY));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    render(<OverviewView />);

    expect(await screen.findByText("Telemetria ao vivo")).toBeInTheDocument();
  });

  it("mescla os avisos das duas leituras e deduplica por code", async () => {
    mockFetchSummary.mockResolvedValue(
      okResource(SUMMARY, {
        availability: "partial",
        warnings: [{ code: "SHARED", message: "AVISO_DO_RESUMO" }],
      }),
    );
    mockFetchOverview.mockResolvedValue(
      okResource(OVERVIEW, {
        availability: "partial",
        warnings: [
          { code: "SHARED", message: "AVISO_DA_TELEMETRIA" },
          { code: "SO_DA_TELEMETRIA", message: "AVISO_EXTRA" },
        ],
      }),
    );

    render(<OverviewView />);

    // Fica o do resumo (primeira ocorrência do code "SHARED"); some o da telemetria.
    expect(await screen.findByText(/AVISO_DO_RESUMO/)).toBeInTheDocument();
    expect(screen.queryByText(/AVISO_DA_TELEMETRIA/)).not.toBeInTheDocument();
    // Dois avisos no total: o primeiro é mostrado, resta um.
    expect(screen.getByText(/\(\+1 aviso\)/)).toBeInTheDocument();
  });

  it("cai para overview.error quando o resumo não tem erro próprio", async () => {
    mockFetchSummary.mockResolvedValue(okResource(SUMMARY));
    mockFetchOverview.mockRejectedValue(new Error("telemetria caiu"));

    render(<OverviewView />);

    // O cabeçalho anuncia a falha da telemetria mesmo com o resumo íntegro.
    expect(await screen.findByText("Leitura falhou")).toBeInTheDocument();
    expect(screen.getByText("Sessões afetadas")).toBeInTheDocument();
  });

  it("o botão atualizar refaz as duas leituras, não só o resumo", async () => {
    mockFetchSummary.mockResolvedValue(okResource(SUMMARY));
    mockFetchOverview.mockResolvedValue(okResource(OVERVIEW));

    render(<OverviewView />);
    await screen.findByText("Sessões afetadas");

    expect(mockFetchSummary).toHaveBeenCalledTimes(1);
    expect(mockFetchOverview).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Atualizar dados" }),
    );

    await waitFor(() => {
      expect(mockFetchSummary).toHaveBeenCalledTimes(2);
      expect(mockFetchOverview).toHaveBeenCalledTimes(2);
    });
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceData } from "@/app/(painel)/incidentes/detalhe/evidence-data";
import type { Resource } from "@/lib/data/client";

const mockFetchEvidence = vi.hoisted(() => vi.fn());
const mockRequestReanalysis = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({
  pathname: "/incidentes/detalhe/",
  search: "incidente=inc_1",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
  useRouter: () => ({ replace: route.replace }),
}));
vi.mock("@/components/account/account-provider", () => ({
  useAccount: () => ({ profile: { name: "Pessoa Teste" } }),
}));
vi.mock("@/app/(painel)/incidentes/detalhe/evidence-resource", () => ({
  fetchEvidence: mockFetchEvidence,
  requestReanalysis: mockRequestReanalysis,
  reviewHypothesis: vi.fn(),
}));

import { EvidenceView } from "@/app/(painel)/incidentes/detalhe/evidence-view";
import { TimelineView } from "@/app/(painel)/incidentes/detalhe/timeline-view";

const EMPTY: EvidenceData = {
  incidentId: "inc_1",
  incident: {
    id: "inc_1",
    number: "INC-E2E-0044",
    title: "INC-E2E-0044",
    startedAt: new Date().toISOString(),
    startedMinutesAgo: 1321,
    severity: "P1",
    investigationStatus: "investigating",
    affectedDevices: null,
    component: null,
  },
  diagnosisStatus: "not_started",
  hypothesis: null,
  reviewStatus: "pending",
  concentration: [],
  concentrationNote: "",
  sources: [],
  buffering: null,
  timeline: [],
  changes: [],
};

function ok(data: EvidenceData): Resource<EvidenceData> {
  return {
    data,
    source: "api",
    availability: "measured",
    warnings: [],
    fetchedAt: new Date(),
  };
}

function evidenceSources(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evd_${index}`,
    eventId: `evt_${index}`,
    incidentId: "inc_1",
    observedAt: null,
    qualityStatus: "verified",
    qualityFlags: [],
    source: "Argus",
    dataset: "signal_bucket",
    type: "argus_event_correlation",
    relation: index < 9 ? ("supports" as const) : ("contradicts" as const),
    strength: index % 3 === 0 ? ("strong" as const) : index % 3 === 1 ? ("moderate" as const) : ("weak" as const),
    summary: `resumo ${index}`,
    fields: [],
  }));
}

beforeEach(() => {
  mockFetchEvidence.mockReset();
  mockRequestReanalysis.mockReset();
  route.pathname = "/incidentes/detalhe/";
  route.search = "incidente=inc_1";
  route.replace.mockReset();
});

describe("diagnóstico do incidente", () => {
  it("mostra estados vazios sem esqueletos presos quando não há dado", async () => {
    mockFetchEvidence.mockResolvedValue(ok(EMPTY));
    const { container } = render(<EvidenceView />);

    expect(await screen.findByText("Nenhuma evidência correlacionada")).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton")).toHaveLength(0);
    // Código legível no lugar do id interno, com duração em horas.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("INC-E2E-0044");
    expect(screen.getByText(/há 22 h/)).toBeInTheDocument();
    expect(screen.getByText("Em investigação")).toBeInTheDocument();
  });

  it("pagina e filtra as evidências por relação", async () => {
    mockFetchEvidence.mockResolvedValue(ok({ ...EMPTY, sources: evidenceSources(12) }));
    render(<EvidenceView />);

    expect(await screen.findByText("Exibindo 1–10 de 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sustentam 9" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contradizem 3" })).toBeInTheDocument();
  });

  it("filtra por força e guarda relação, força e página na URL", async () => {
    // A força vem da URL: recarregar ou compartilhar reproduz o recorte.
    route.search = "incidente=inc_1&forca=strong";
    window.history.replaceState(null, "", "/incidentes/detalhe/?" + route.search);
    mockFetchEvidence.mockResolvedValue(ok({ ...EMPTY, sources: evidenceSources(12) }));
    render(<EvidenceView />);

    const strength = await screen.findByRole("group", { name: "Filtrar evidências por força" });
    expect(within(strength).getByRole("button", { name: "Forte 4" })).toHaveAttribute("aria-pressed", "true");
    expect(within(strength).getByRole("button", { name: "Moderada 4" })).toBeInTheDocument();
    // A contagem por relação respeita a força escolhida.
    expect(screen.getByRole("button", { name: "Sustentam 3" })).toBeInTheDocument();
    expect(screen.getByText("Exibindo 1–4 de 4")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Contradizem 1" }));
    expect(route.replace).toHaveBeenCalledWith(
      "/incidentes/detalhe/?incidente=inc_1&forca=strong&relacao=contradicts",
      { scroll: false },
    );
  });

  it("mostra a trilha com a aba e pede a reanálise", async () => {
    mockFetchEvidence.mockResolvedValue(ok(EMPTY));
    mockRequestReanalysis.mockResolvedValue({
      ok: false,
      needsSignIn: false,
      message: "A reanálise manual ainda não está habilitada neste ambiente.",
    });
    render(<EvidenceView />);

    const trail = await screen.findByRole("navigation", { name: "Trilha de navegação" });
    expect(within(trail).getByRole("link", { name: "Incidentes" })).toHaveAttribute("href", "/incidentes");
    expect(within(trail).getByText("Diagnóstico")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Voltar para Incidentes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linha do tempo" })).toHaveAttribute(
      "href",
      "/incidentes/detalhe/linha-do-tempo?incidente=inc_1",
    );

    await userEvent.click(screen.getByRole("button", { name: "Reanalisar" }));
    expect(mockRequestReanalysis).toHaveBeenCalledWith("inc_1");
    expect(await screen.findByRole("alert")).toHaveTextContent("ainda não está habilitada");
  });

  it("mostra a linha do tempo na aba própria, sem esqueleto preso", async () => {
    route.pathname = "/incidentes/detalhe/linha-do-tempo/";
    mockFetchEvidence.mockResolvedValue(ok(EMPTY));
    const { container } = render(<TimelineView />);

    expect(await screen.findByText("Sem linha do tempo de mudanças")).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton")).toHaveLength(0);
    const trail = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(within(trail).getByText("Linha do tempo")).toHaveAttribute("aria-current", "page");
    expect(within(trail).getByRole("link", { name: "INC-E2E-0044" })).toBeInTheDocument();
  });

  it("trata a leitura que falhou como indisponível, e não como carregando", async () => {
    mockFetchEvidence.mockResolvedValue({
      source: "indisponivel",
      availability: "unavailable",
      warnings: [{ code: "READ_FAILED", message: "O gateway respondeu 500." }],
      fetchedAt: new Date(),
    });
    render(<EvidenceView />);

    expect(await screen.findByText("Diagnóstico indisponível")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("O gateway respondeu 500.");
  });
});

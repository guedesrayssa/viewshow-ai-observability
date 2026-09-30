import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoadMore, Pagination, usePagedItems } from "@/components/ui/pagination";
import { toCsv } from "@/lib/export";
import { formatDateTime, formatElapsed } from "@/lib/format";
import { incidentCode, incidentHeadline, incidentStatusLabel } from "@/lib/incidents/labels";
import {
  eventsFeedHref,
  incidentDiagnosisHref,
  incidentEventsHref,
  incidentsHref,
  incidentTimelineHref,
  normalizePath,
} from "@/lib/routes";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const meta = {
  requestId: "req_flow",
  schemaVersion: "1.0",
  datasetVersion: `dsv_${"a".repeat(64)}`,
  generatedAt: "2026-01-01T12:00:00.000Z",
  window: null,
  partial: false,
  refreshAfterSeconds: 60,
  freshness: [],
  warnings: [],
};

function response(data: unknown) {
  return new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("rotas do incidente", () => {
  it("leva o incidente na query string das abas e do feed", () => {
    expect(incidentDiagnosisHref("inc 1")).toBe("/incidentes/detalhe?incidente=inc+1");
    expect(incidentEventsHref("inc_1", "evt_2")).toBe(
      "/incidentes/detalhe/eventos?incidente=inc_1&evento=evt_2",
    );
    expect(incidentEventsHref("inc_1")).toBe("/incidentes/detalhe/eventos?incidente=inc_1");
    expect(eventsFeedHref()).toBe("/incidentes/feed-eventos");
    expect(incidentTimelineHref("inc_1")).toBe(
      "/incidentes/detalhe/linha-do-tempo?incidente=inc_1",
    );
    // "Ver todos" da Visão Geral abre a lista num período que inclui os
    // incidentes que ela mostra.
    expect(incidentsHref("all")).toBe("/incidentes?periodo=all");
    expect(incidentsHref()).toBe("/incidentes");
    expect(normalizePath("/incidentes/detalhe/")).toBe("/incidentes/detalhe");
  });

  it("mostra o número do incidente em vez do id interno, sem repetir o título", () => {
    const incident = { id: "inc_x7ev", number: "INC-E2E-0044", title: "INC-E2E-0044" };
    expect(incidentCode(incident)).toBe("INC-E2E-0044");
    expect(incidentHeadline(incident)).toBe("");
    expect(incidentCode({ id: "inc_x7ev", number: null })).toBe("inc_x7ev");
    expect(incidentStatusLabel("investigating")).toBe("Em investigação");
  });
});

describe("formatação de datas", () => {
  it("sempre diz o dia junto da hora", () => {
    const now = new Date(2026, 8, 29, 20, 0);
    expect(formatDateTime(new Date(2026, 8, 29, 19, 0).toISOString(), { now })).toBe(
      "Hoje, 19:00",
    );
    expect(formatDateTime(new Date(2026, 8, 28, 19, 0).toISOString(), { now })).toBe(
      "Ontem, 19:00",
    );
    expect(formatDateTime(new Date(2026, 8, 20, 19, 0).toISOString(), { now })).toBe(
      "20/09, 19:00",
    );
    expect(formatDateTime(null)).toBe("Sem horário");
  });

  it("escreve durações longas em horas e dias", () => {
    expect(formatElapsed(42)).toBe("42 min");
    expect(formatElapsed(1321)).toBe("22 h");
    expect(formatElapsed(3000)).toBe("2 d 2 h");
  });
});

describe("paginação", () => {
  function PagedList({ page, size }: { page: number; size: number }) {
    const items = Array.from({ length: 23 }, (_, index) => `item ${index + 1}`);
    const paged = usePagedItems(items, page, size);
    return (
      <ul>
        {paged.pageItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
        <li data-testid="page">{paged.page}</li>
      </ul>
    );
  }

  it("fatia a lista e não passa da última página", () => {
    const { rerender } = render(<PagedList page={3} size={10} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("item 21")).toBeInTheDocument();

    rerender(<PagedList page={9} size={10} />);
    expect(screen.getByTestId("page")).toHaveTextContent("3");
  });

  it("diz quanto do total está na tela e troca de página", async () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        itemLabel="incidentes"
        page={2}
        pageCount={3}
        pageSize={10}
        total={23}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText("Exibindo 11–20 de 23")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("mostra a contagem do bloco carregado e o total da origem", () => {
    render(
      <LoadMore
        itemLabel="eventos"
        shown={50}
        total={363}
        hasMore
        loading={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByText("Exibindo 50 de 363 eventos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Carregar mais" })).toBeInTheDocument();
  });
});

describe("exportação", () => {
  it("gera CSV com ponto e vírgula e escapa aspas", () => {
    const csv = toCsv(
      [{ name: 'Falha "grave"; TV', value: 3 }],
      [
        { header: "Nome", value: (row) => row.name },
        { header: "Valor", value: (row) => row.value },
      ],
    );
    expect(csv).toBe('Nome;Valor\r\n"Falha ""grave""; TV";3');
  });
});

describe("reanálise do incidente", () => {
  it("envia POST com chave de idempotência e aceita o 202", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { requestReanalysis } = await import("@/app/(painel)/incidentes/detalhe/evidence-resource");

    await expect(requestReanalysis("inc_1")).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway.test/api/v1/incidents/inc_1/reanalyze");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("explica quando a reanálise manual não está habilitada no ambiente", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "FEATURE_UNAVAILABLE", message: "unavailable" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    )));
    const { requestReanalysis } = await import("@/app/(painel)/incidentes/detalhe/evidence-resource");

    const result = await requestReanalysis("inc_1");
    expect(result).toMatchObject({ ok: false, needsSignIn: false });
    expect(result.ok ? "" : result.message).toContain("ainda não está habilitada");
  });
});

describe("leituras de incidentes e eventos", () => {
  it("pede até 100 incidentes e não envia filtros que a origem rejeita", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        capabilities: { filtering: { supportedDimensions: ["priority", "status"] } },
        items: [
          {
            id: "inc_1",
            number: "INC-1",
            title: "INC-1",
            priority: "P1",
            status: "investigating",
            startedAt: "2026-01-01T11:00:00.000Z",
            impact: { affectedDevices: { value: null, measurement: { status: "unknown" } } },
            primaryComponent: null,
            scopeSummary: [],
          },
        ],
        impactSeries: { points: [] },
        page: { limit: 100, hasMore: true, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchIncidents } = await import("@/app/(painel)/incidentes/incidents-resource");

    const resource = await fetchIncidents({
      period: "all",
      priority: "P1",
      status: "all",
      sort: "urgency",
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("limit=100");
    expect(url).toContain("window=all");
    expect(url).toContain("priority=P1");
    expect(url).toContain("sort=priority");
    expect(url).not.toContain("status=");
    expect(url).not.toContain("region=");
    expect(resource.data).toMatchObject({
      hasMore: true,
      supportedDimensions: ["priority", "status"],
      items: [{ code: "INC-1", title: "", status: "investigating" }],
    });
  });

  it("recorta incidentes em últimas 24 horas e mais de 24 horas na tela", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const incident = (id: string, hoursAgo: number) => ({
      id,
      number: id.toUpperCase(),
      title: id,
      priority: "P2",
      status: "investigating",
      startedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
      impact: { affectedDevices: { value: null, measurement: { status: "unknown" } } },
      primaryComponent: null,
      scopeSummary: [],
    });
    const fetchMock = vi.fn(async () =>
      response({
        capabilities: { filtering: { supportedDimensions: ["priority", "status"] } },
        items: [incident("inc_recente", 3), incident("inc_antigo", 40)],
        impactSeries: { points: [] },
        page: { limit: 100, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchIncidents } = await import("@/app/(painel)/incidentes/incidents-resource");

    const recent = await fetchIncidents({ period: "1440" });
    const older = await fetchIncidents({ period: "older" });
    const all = await fetchIncidents({ period: "all" });

    expect(recent.data?.items.map((item) => item.id)).toEqual(["inc_recente"]);
    expect(older.data?.items.map((item) => item.id)).toEqual(["inc_antigo"]);
    expect(all.data?.items).toHaveLength(2);
    // A lista sempre vem inteira da API; o período é aplicado na tela.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("window=all");
    }
  });

  it("pede mais de 24 horas de eventos como intervalo explícito", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        categoryStats: [],
        volumeSeries: null,
        items: [],
        facets: { categories: [], sourceDatasets: [], correlationStatuses: [] },
        page: { limit: 50, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEvents } = await import("@/app/(painel)/incidentes/_eventos/events-resource");

    await fetchEvents({
      incidentId: "",
      period: "older",
      search: "",
      category: "all",
      source: "all",
      correlation: "all",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const to = Date.parse(url.searchParams.get("to") ?? "");
    const from = Date.parse(url.searchParams.get("from") ?? "");
    expect(url.searchParams.has("window")).toBe(false);
    expect(Date.now() - to).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
    expect(to - from).toBeLessThanOrEqual(31 * 24 * 3600_000);
  });

  it("usa a mesma janela da lista no gráfico de volume de eventos", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        categoryStats: [],
        volumeSeries: { points: [{ timestamp: "2026-01-01T11:00:00.000Z", count: 4 }] },
        items: [],
        facets: { categories: [], sourceDatasets: [], correlationStatuses: [] },
        page: { limit: 1, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEventVolume } = await import("@/app/(painel)/incidentes/_eventos/events-resource");

    const base = {
      incidentId: "",
      period: "360",
      search: "",
      category: "all" as const,
      source: "all",
      correlation: "all" as const,
    };
    await fetchEventVolume(base);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("window=6h");

    // O gráfico segue os mesmos filtros da lista.
    await fetchEventVolume({ ...base, search: "smart", category: "live_event", source: "signal_point", correlation: "unlinked" });
    const filtered = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(filtered.searchParams.get("search")).toBe("smart");
    expect(filtered.searchParams.get("category")).toBe("live_event");
    expect(filtered.searchParams.get("sourceDataset")).toBe("signal_point");
    expect(filtered.searchParams.get("correlation")).toBe("unlinked");

    // Um intervalo explícito vai como from/to, no lugar da janela.
    const range = { from: "2026-01-01T10:00:00.000Z", to: "2026-01-01T12:00:00.000Z" };
    await fetchEventVolume({ ...base, range });
    const ranged = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(ranged.searchParams.get("from")).toBe(range.from);
    expect(ranged.searchParams.get("to")).toBe(range.to);
    expect(ranged.searchParams.has("window")).toBe(false);
  });
});

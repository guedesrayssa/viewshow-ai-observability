/**
 * @file overview-view.integration.test.tsx
 * Caminho completo, sem dublê de leitura.
 *
 * `overview-view.test.tsx` mocka `fetchSummary`/`fetchOverview` e entrega o
 * recurso já normalizado; este arquivo fecha a lacuna entre os dois níveis:
 * só o `fetch` global é dublê. `fetchSummary`, `fetchOverview`,
 * `composeResource` e `useResource` são os de produção.
 *
 * Cenário do achado do P1: a API operacional está fora do ar (o `fetch`
 * rejeita). O esperado é a tela desenhar `<Unavailable>` nos blocos do resumo
 * — nunca ficar presa no espaço reservado.
 *
 * As duas APIs precisam estar apontadas por variável de ambiente, senão a
 * leitura curto-circuita em API_NOT_CONFIGURED antes de tocar no `fetch`.
 * `API_BASES` é lido na carga do módulo, então o stub vai em `vi.hoisted`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  vi.stubEnv("NEXT_PUBLIC_TELEMETRY_API_BASE_URL", "http://telemetria.test");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "false");
});

import { render, screen, within } from "@testing-library/react";

import { OverviewView } from "@/app/(painel)/visao-geral/overview-view";

beforeEach(() => {
  // As duas leituras da tela batem em APIs diferentes; qualquer uma que caia
  // aqui rejeita, simulando o transporte fora do ar.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("Visão Geral — ponta a ponta com a API operacional fora do ar", () => {
  it("desenha <Unavailable> nos blocos do resumo em vez de ficar preso no espaço reservado", async () => {
    const { container } = render(<OverviewView />);

    // Começa em espaço reservado enquanto a leitura não termina.
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);

    // Terminada a leitura sem fonte, os blocos do resumo declaram indisponível.
    expect(
      await screen.findByText("Indicadores de incidentes indisponíveis"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Incidentes recentes indisponíveis"),
    ).toBeInTheDocument();

    // E nada continua preso em skeleton.
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
    expect(screen.queryByText("Sessões afetadas")).not.toBeInTheDocument();
  });

  it("dispara o Alert do topo quando o resumo fica sem fonte", async () => {
    render(<OverviewView />);

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível ler o resumo de incidentes");
    expect(
      within(alerta).getByText(/Tente atualizar em alguns instantes\./),
    ).toBeInTheDocument();
  });

  it("chamou o fetch de fato — a leitura não foi curto-circuitada", async () => {
    render(<OverviewView />);

    await screen.findByText("Indicadores de incidentes indisponíveis");

    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

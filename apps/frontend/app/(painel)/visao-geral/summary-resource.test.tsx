/**
 * @file summary-resource.test.tsx
 * Conversão do `value` do indicador e o que o cartão desenha quando ela não
 * resolve um número.
 *
 * O front e o back sobem por jobs independentes: por uma janela, o número pode
 * chegar formatado em pt-BR. `toNumericValue` faz a ponte, e o que ela não
 * consegue ler tem que virar travessão — nunca um zero, que afirmaria medição.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatCard } from "@/components/dashboard/stat-card";
import { toNumericValue } from "@/app/(painel)/visao-geral/summary-resource";

describe("toNumericValue", () => {
  it("repassa um número finito sem tocar", () => {
    expect(toNumericValue(12400)).toBe(12400);
    expect(toNumericValue(0)).toBe(0);
    expect(toNumericValue(-3)).toBe(-3);
    expect(toNumericValue(12400.5)).toBe(12400.5);
  });

  it("lê string pt-BR com ponto de milhar", () => {
    expect(toNumericValue("12.400")).toBe(12400);
    expect(toNumericValue("1.234.567")).toBe(1234567);
    expect(toNumericValue(" 12.400 ")).toBe(12400);
  });

  it("lê string pt-BR com milhar e vírgula decimal", () => {
    expect(toNumericValue("12.400,50")).toBe(12400.5);
    expect(toNumericValue("3,5")).toBe(3.5);
  });

  it("devolve null para string vazia ou só espaço — nunca 0", () => {
    expect(toNumericValue("")).toBeNull();
    expect(toNumericValue("   ")).toBeNull();
  });

  it("devolve null para texto ilegível — nunca NaN", () => {
    for (const entrada of ["abc", "12 mil", "R$ --", "—"]) {
      const saida = toNumericValue(entrada);
      expect(saida).toBeNull();
      expect(Number.isNaN(saida as number)).toBe(false);
    }
  });

  it("devolve null para número não finito", () => {
    expect(toNumericValue(Number.NaN)).toBeNull();
    expect(toNumericValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("StatCard com valor resolvido null", () => {
  it("desenha travessão e não escreve 0", () => {
    render(
      <StatCard
        id="affected-sessions"
        label="Sessões afetadas"
        value={toNumericValue("")}
        format="compact"
        delta=""
        accent="info"
        deltaTone="neutral"
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("anima o número quando o valor resolve", () => {
    render(
      <StatCard
        id="affected-sessions"
        label="Sessões afetadas"
        value={toNumericValue("12.400")}
        format="compact"
        delta=""
        accent="info"
        deltaTone="neutral"
      />,
    );

    expect(screen.queryByText("—")).not.toBeInTheDocument();
    // "12,4 mil" no padrão dos cartões de impacto.
    expect(screen.getByText(/12,4\s*mil/)).toBeInTheDocument();
  });
});

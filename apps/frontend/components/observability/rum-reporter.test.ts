import { describe, expect, it } from "vitest";

import { isIncidentDiagnosisHref } from "@/components/observability/rum-reporter";

describe("observabilidade da investigação", () => {
  it("reconhece a nova rota de diagnóstico com incidente explícito", () => {
    expect(isIncidentDiagnosisHref("/incidentes/detalhe?incidente=inc_1")).toBe(
      true,
    );
    expect(
      isIncidentDiagnosisHref(
        "https://painel.example/incidentes/detalhe/?incidente=inc_2",
      ),
    ).toBe(true);
  });

  it("não encerra a métrica em abas ou rotas sem incidente", () => {
    expect(isIncidentDiagnosisHref("/incidentes/detalhe")).toBe(false);
    expect(
      isIncidentDiagnosisHref("/incidentes/detalhe/eventos?incidente=inc_1"),
    ).toBe(false);
    expect(isIncidentDiagnosisHref("/evidencias?incidente=inc_1")).toBe(false);
  });
});

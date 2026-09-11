import { test } from "node:test";
import assert from "node:assert/strict";

import { lowConfidenceWarning, rankByConfidence, DEFAULT_CONFIDENCE_FLOOR } from "../src/domain/outcome.js";
import type { Hypothesis } from "../src/domain/diagnosis.js";

function hipotese(confidence: number, title = "h"): Hypothesis {
  return {
    id: "hyp_01",
    rank: 1,
    title,
    explanation: "e",
    confidence,
    supportingEvidenceIds: ["ev_01"],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    reviewStatus: "pending",
  };
}

test("uma hipótese acima do piso dispensa ressalva", () => {
  assert.equal(lowConfidenceWarning([hipotese(0.2), hipotese(0.7)]), null);
});

test("nada acima do piso gera ressalva, e não muda o estado do diagnóstico", () => {
  // Inconclusivo é veredito humano (analise-e-ia.md §9): a máquina anexa o
  // aviso e ainda assim manda as hipóteses fracas para revisão.
  const aviso = lowConfidenceWarning([hipotese(0.2), hipotese(0.3)]);
  assert.equal(aviso?.code, "BELOW_CONFIDENCE_FLOOR");
  assert.match(aviso?.detail ?? "", /0\.30/);
});

test("exatamente no piso não gera ressalva", () => {
  assert.equal(lowConfidenceWarning([hipotese(DEFAULT_CONFIDENCE_FLOOR)]), null);
});

test("o piso é configurável sem tocar na validação", () => {
  assert.equal(lowConfidenceWarning([hipotese(0.6)], 0.9)?.code, "BELOW_CONFIDENCE_FLOOR");
});

test("reordena por confiança e renumera o ranque", () => {
  const ordenadas = rankByConfidence([hipotese(0.3, "baixa"), hipotese(0.9, "alta")]);
  assert.deepEqual(ordenadas.map((h) => [h.title, h.rank]), [["alta", 1], ["baixa", 2]]);
});

test("empate preserva a ordem em que o modelo devolveu", () => {
  const ordenadas = rankByConfidence([hipotese(0.5, "primeira"), hipotese(0.5, "segunda")]);
  assert.deepEqual(ordenadas.map((h) => h.title), ["primeira", "segunda"]);
});

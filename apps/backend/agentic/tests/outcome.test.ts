import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyOutcome, rankByConfidence, DEFAULT_CONFIDENCE_FLOOR } from "../src/domain/outcome.js";
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
  };
}

test("uma hipótese acima do piso torna o diagnóstico conclusivo", () => {
  assert.equal(classifyOutcome([hipotese(0.2), hipotese(0.7)]), "ready");
});

test("nada acima do piso é inconclusivo, não falha", () => {
  // O sistema funcionou e não tinha o que dizer; isso não deve alarmar.
  assert.equal(classifyOutcome([hipotese(0.2), hipotese(0.3)]), "inconclusive");
});

test("exatamente no piso conta como conclusivo", () => {
  assert.equal(classifyOutcome([hipotese(DEFAULT_CONFIDENCE_FLOOR)]), "ready");
});

test("o piso é configurável sem tocar na validação", () => {
  assert.equal(classifyOutcome([hipotese(0.6)], 0.9), "inconclusive");
});

test("reordena por confiança e renumera o ranque", () => {
  const ordenadas = rankByConfidence([hipotese(0.3, "baixa"), hipotese(0.9, "alta")]);
  assert.deepEqual(ordenadas.map((h) => [h.title, h.rank]), [["alta", 1], ["baixa", 2]]);
});

test("empate preserva a ordem em que o modelo devolveu", () => {
  const ordenadas = rankByConfidence([hipotese(0.5, "primeira"), hipotese(0.5, "segunda")]);
  assert.deepEqual(ordenadas.map((h) => h.title), ["primeira", "segunda"]);
});

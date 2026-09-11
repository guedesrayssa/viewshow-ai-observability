import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDiagnosisResponse, MAX_HYPOTHESES } from "../src/domain/response-validation.js";
import { createFakeProvider, type FakeHypothesis } from "../src/adapters/llm/fake-provider.js";

const EVIDENCIAS = new Set(["ev_01", "ev_02", "ev_03"]);

const HIPOTESE_BOA: FakeHypothesis = {
  title: "Degradação de entrega na CDN",
  explanation: "A taxa de erro subiu junto com as falhas de CDN.",
  confidence: 0.84,
  supportingEvidenceIds: ["ev_01", "ev_02"],
};

/** Roda o provider falso e valida — o caminho que a aplicação real percorre. */
async function validar(
  options: Parameters<typeof createFakeProvider>[0],
  conhecidas: ReadonlySet<string> = EVIDENCIAS,
) {
  const provider = createFakeProvider(options);
  const resposta = await provider.generate({ systemPrompt: "s", userPrompt: "u" });
  return parseDiagnosisResponse(resposta, conhecidas);
}

function codigos(resultado: Awaited<ReturnType<typeof validar>>): readonly string[] {
  return resultado.ok ? [] : resultado.failures.map((f) => f.code);
}

test("aceita resposta bem formada e ancorada em evidência existente", async () => {
  const resultado = await validar({ hypotheses: [HIPOTESE_BOA] });
  assert.ok(resultado.ok);
  if (!resultado.ok) return;
  assert.equal(resultado.hypotheses.length, 1);
  assert.equal(resultado.hypotheses[0]?.title, "Degradação de entrega na CDN");
});

test("atribui id e ranque, que o modelo nunca escreve", async () => {
  const resultado = await validar({
    hypotheses: [HIPOTESE_BOA, { ...HIPOTESE_BOA, title: "Segunda", confidence: 0.4 }],
  });
  assert.ok(resultado.ok);
  if (!resultado.ok) return;
  assert.deepEqual(
    resultado.hypotheses.map((h) => [h.id, h.rank]),
    [["hyp_01", 1], ["hyp_02", 2]],
  );
});

test("rejeita resposta truncada em vez de aceitar diagnóstico parcial", async () => {
  const resultado = await validar({ hypotheses: [HIPOTESE_BOA], stopReason: "length" });
  assert.deepEqual(codigos(resultado), ["TRUNCATED"]);
});

test("rejeita texto que não é JSON", async () => {
  const resultado = await validar({ rawText: "Claro! Aqui vai a análise..." });
  assert.deepEqual(codigos(resultado), ["NOT_JSON"]);
});

test("aceita JSON embrulhado em cerca de código", async () => {
  const corpo = JSON.stringify({ hypotheses: [{ ...HIPOTESE_BOA, contradictingEvidenceIds: [], missingEvidence: [] }] });
  const resultado = await validar({ rawText: "```json\n" + corpo + "\n```" });
  assert.ok(resultado.ok);
});

test("rejeita evidência inventada — o caso que a injeção de prompt produz", async () => {
  // Mesmo que o texto plantado convença o modelo, ele não consegue citar um
  // identificador que exista de verdade no pacote.
  const resultado = await validar({
    hypotheses: [{ ...HIPOTESE_BOA, supportingEvidenceIds: ["ev_01", "ev_99"] }],
  });
  assert.deepEqual(codigos(resultado), ["UNKNOWN_EVIDENCE"]);
});

test("rejeita evidência inventada também na lista de contradição", async () => {
  const resultado = await validar({
    hypotheses: [{ ...HIPOTESE_BOA, contradictingEvidenceIds: ["ev_inexistente"] }],
  });
  assert.deepEqual(codigos(resultado), ["UNKNOWN_EVIDENCE"]);
});

test("rejeita hipótese sem nenhuma evidência de apoio", async () => {
  const resultado = await validar({ hypotheses: [{ ...HIPOTESE_BOA, supportingEvidenceIds: [] }] });
  assert.deepEqual(codigos(resultado), ["UNGROUNDED"]);
});

test("rejeita confiança fora de 0 a 1", async () => {
  const resultado = await validar({ hypotheses: [{ ...HIPOTESE_BOA, confidence: 85 }] });
  assert.deepEqual(codigos(resultado), ["MALFORMED"]);
});

test("rejeita lista vazia de hipóteses", async () => {
  const resultado = await validar({ hypotheses: [] });
  assert.deepEqual(codigos(resultado), ["EMPTY"]);
});

test("rejeita resposta acima do teto de hipóteses", async () => {
  const muitas = Array.from({ length: MAX_HYPOTHESES + 1 }, (_, i) => ({
    ...HIPOTESE_BOA,
    title: `Hipótese ${i}`,
  }));
  const resultado = await validar({ hypotheses: muitas });
  assert.deepEqual(codigos(resultado), ["TOO_MANY"]);
});

test("uma hipótese ruim não derruba as boas, mas o motivo não se perde", async () => {
  const resultado = await validar({
    hypotheses: [HIPOTESE_BOA, { ...HIPOTESE_BOA, title: "Inventada", supportingEvidenceIds: ["ev_99"] }],
  });
  assert.ok(resultado.ok);
  if (!resultado.ok) return;
  // Sobra só a boa, e ela é reranqueada como primeira.
  assert.equal(resultado.hypotheses.length, 1);
  assert.equal(resultado.hypotheses[0]?.rank, 1);
  // E o descarte continua visível: é indício de injeção parcial.
  assert.deepEqual(resultado.discarded.map((f) => f.code), ["UNKNOWN_EVIDENCE"]);
});

test("sucesso limpo reporta lista de descarte vazia", async () => {
  const resultado = await validar({ hypotheses: [HIPOTESE_BOA] });
  assert.ok(resultado.ok);
  if (!resultado.ok) return;
  assert.deepEqual(resultado.discarded, []);
});

test("resposta em que nada sobrevive é rejeitada com todos os motivos", async () => {
  const resultado = await validar({
    hypotheses: [
      { ...HIPOTESE_BOA, supportingEvidenceIds: ["ev_99"] },
      { ...HIPOTESE_BOA, supportingEvidenceIds: [] },
    ],
  });
  assert.deepEqual(codigos(resultado), ["UNKNOWN_EVIDENCE", "UNGROUNDED"]);
});

test("o provider falso registra o que recebeu, para asserção sobre o prompt", async () => {
  const provider = createFakeProvider({ hypotheses: [HIPOTESE_BOA] });
  await provider.generate({ systemPrompt: "sistema", userPrompt: "usuário" });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.systemPrompt, "sistema");
});

test("o provider falso propaga erro, para o caminho de falha do provider", async () => {
  const provider = createFakeProvider({ throws: new Error("throttled") });
  await assert.rejects(
    () => provider.generate({ systemPrompt: "s", userPrompt: "u" }),
    /throttled/,
  );
});

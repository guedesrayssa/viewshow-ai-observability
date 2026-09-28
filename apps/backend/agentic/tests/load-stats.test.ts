import { test } from "node:test";
import assert from "node:assert/strict";
import { percentil, resumir, type Amostra } from "../scripts/load-stats.js";

test("percentil usa posto mais próximo e devolve valor observado", () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentil(v, 50), 50);
  assert.equal(percentil(v, 95), 100);
  assert.equal(percentil(v, 0), 10);
  assert.equal(percentil([], 95), 0);
});

test("resumir agrega latência, vazão, falhas, motivos e tokens", () => {
  const amostras: Amostra[] = [
    { totalMs: 100, llmMs: 90, status: "ready", reasonCodes: [], inputTokens: 10, outputTokens: 5 },
    { totalMs: 300, llmMs: 280, status: "failed", reasonCodes: ["PROVIDER_ERROR"] },
    { totalMs: 2, llmMs: null, status: "pending", reasonCodes: ["NO_EVIDENCE"] },
    { totalMs: 200, llmMs: 190, status: "ready", reasonCodes: [], inputTokens: 12, outputTokens: 6 },
  ];
  const r = resumir(2, 1000, amostras);

  assert.equal(r.requisicoes, 4);
  assert.equal(r.vazaoPorSegundo, 4);
  assert.equal(r.latenciaMs.min, 2);
  assert.equal(r.latenciaMs.max, 300);
  assert.equal(r.latenciaMs.p50, 100);
  assert.equal(r.latenciaLlmP95Ms, 280);
  assert.deepEqual(r.status, { ready: 2, failed: 1, pending: 1 });
  assert.deepEqual(r.motivos, { PROVIDER_ERROR: 1, NO_EVIDENCE: 1 });
  assert.equal(r.taxaFalha, 0.25);
  assert.deepEqual(r.tokens, { entrada: 22, saida: 11 });
});

test("estágio sem chamada ao modelo não inventa latência de LLM", () => {
  const r = resumir(1, 10, [{ totalMs: 1, llmMs: null, status: "pending", reasonCodes: [] }]);
  assert.equal(r.latenciaLlmP95Ms, null);
});

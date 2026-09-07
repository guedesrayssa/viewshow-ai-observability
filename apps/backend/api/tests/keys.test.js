const test = require("node:test");
const assert = require("node:assert/strict");

const { incidentSk, evidenceSk, hypothesisSk, itemTypeFromSk } = require("../src/db/keys");

test("evidenceSk e hypothesisSk usam prefixo próprio, não INCIDENT#", () => {
  const evidence = evidenceSk("inc-000001", 1);
  const hypothesis = hypothesisSk("inc-000001", 42);

  assert.equal(evidence, "EVIDENCE#inc-000001#001");
  assert.equal(hypothesis, "HYPOTHESIS#inc-000001#0000000042");
  assert.ok(!evidence.startsWith("INCIDENT#"));
  assert.ok(!hypothesis.startsWith("INCIDENT#"));
});

test("itemTypeFromSk classifica os três tipos pelo prefixo", () => {
  assert.equal(itemTypeFromSk(incidentSk("inc-000001")), "INCIDENT");
  assert.equal(itemTypeFromSk(evidenceSk("inc-000001", 1)), "EVIDENCE");
  assert.equal(itemTypeFromSk(hypothesisSk("inc-000001", 42)), "HYPOTHESIS");
  assert.equal(itemTypeFromSk("QUALQUER#outra-coisa"), "UNKNOWN");
});

test("itemTypeFromSk mantém leitura compatível com filhos do schema v1", () => {
  assert.equal(itemTypeFromSk("INCIDENT#inc-000001#EVIDENCE#001"), "EVIDENCE");
  assert.equal(itemTypeFromSk("INCIDENT#inc-000001#HYPOTHESIS#0000000042"), "HYPOTHESIS");
  assert.equal(itemTypeFromSk("INCIDENT#inc-000001#DESCONHECIDO#001"), "UNKNOWN");
});

test("itemTypeFromSk só aceita a chave curta como incidente", () => {
  assert.equal(itemTypeFromSk("INCIDENT#inc-000001"), "INCIDENT");
  assert.notEqual(itemTypeFromSk("INCIDENT#inc-000001#EVIDENCE#001"), "INCIDENT");
  assert.notEqual(itemTypeFromSk("INCIDENT#inc-000001#HYPOTHESIS#0000000042"), "INCIDENT");
  assert.equal(itemTypeFromSk(null), "UNKNOWN");
});

test("regressão: begins_with(sk, 'INCIDENT#') não bate mais com filhos", () => {
  // Guarda de regressão do defeito medido em
  // artefatos/sprint2/testes-desempenho.md §8: antes da correção, os três
  // prefixos começavam com "INCIDENT#" e a Query de listIncidents
  // (evidenceService.js) trazia a gaveta inteira — incidentes, evidências e
  // hipóteses — para descartar ~87% em memória.
  assert.ok(incidentSk("inc-1").startsWith("INCIDENT#"));
  assert.ok(!evidenceSk("inc-1", 1).startsWith("INCIDENT#"));
  assert.ok(!hypothesisSk("inc-1", 1).startsWith("INCIDENT#"));
});

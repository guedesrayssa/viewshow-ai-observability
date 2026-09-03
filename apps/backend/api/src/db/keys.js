/**
 * Convenção de chaves de monitoracao-operacional (docs/decisoes.md).
 * Único lugar que sabe montar/interpretar pk e sk — seed.js e os services
 * usam isto, em vez de montar strings soltas em cada lugar.
 *
 * O sk de evidência/hipótese usa prefixo PRÓPRIO (EVIDENCE#/HYPOTHESIS#), não
 * INCIDENT#<id>#EVIDENCE#... A Query de listIncidents (evidenceService.js)
 * filtra por begins_with(sk, "INCIDENT#"); com os três tipos compartilhando
 * esse prefixo, ela lia a gaveta inteira — incidentes, evidências e hipóteses
 * — e descartava ~87% em memória (medido em
 * artefatos/sprint2/testes-desempenho.md, §8). Discriminar o prefixo faz a
 * mesma Query casar só com incidentes de verdade.
 */

function hourBucket(date) {
  return `INC#${date.toISOString().slice(0, 13)}`;
}

function incidentSk(incidentId) {
  return `INCIDENT#${incidentId}`;
}

function evidenceSk(incidentId, seq) {
  return `EVIDENCE#${incidentId}#${String(seq).padStart(3, "0")}`;
}

function hypothesisSk(incidentId, seq) {
  return `HYPOTHESIS#${incidentId}#${String(seq).padStart(10, "0")}`;
}

/** Classifica pelo primeiro segmento do sk — cada tipo tem prefixo próprio. */
function itemTypeFromSk(sk) {
  const prefix = sk.split("#")[0];
  if (prefix === "INCIDENT") return "INCIDENT";
  if (prefix === "EVIDENCE") return "EVIDENCE";
  if (prefix === "HYPOTHESIS") return "HYPOTHESIS";
  return "UNKNOWN";
}

module.exports = { hourBucket, incidentSk, evidenceSk, hypothesisSk, itemTypeFromSk };

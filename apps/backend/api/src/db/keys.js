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

/**
 * Classifica chaves do schema atual e do schema legado durante a transição.
 *
 * v2: EVIDENCE#<id>#<seq> / HYPOTHESIS#<id>#<seq>
 * v1: INCIDENT#<id>#EVIDENCE#<seq> / INCIDENT#<id>#HYPOTHESIS#<seq>
 *
 * A forma do sk inteiro importa: olhar apenas o primeiro segmento faria os
 * filhos v1 parecerem incidentes e poderia sobrescrever bundle.incident.
 */
function itemTypeFromSk(sk) {
  if (typeof sk !== "string") return "UNKNOWN";

  const parts = sk.split("#");
  if (parts[0] === "EVIDENCE" && parts.length >= 3) return "EVIDENCE";
  if (parts[0] === "HYPOTHESIS" && parts.length >= 3) return "HYPOTHESIS";
  if (parts[0] !== "INCIDENT") return "UNKNOWN";

  if (parts.length === 2) return "INCIDENT";
  if (parts[2] === "EVIDENCE" && parts.length >= 4) return "EVIDENCE";
  if (parts[2] === "HYPOTHESIS" && parts.length >= 4) return "HYPOTHESIS";
  return "UNKNOWN";
}

module.exports = { hourBucket, incidentSk, evidenceSk, hypothesisSk, itemTypeFromSk };

/**
 * Convenção de chaves de monitoracao-operacional (docs/decisoes.md).
 * Único lugar que sabe montar/interpretar pk e sk — seed.js e os services
 * usam isto, em vez de montar strings soltas em cada lugar.
 */

function hourBucket(date) {
  return `INC#${date.toISOString().slice(0, 13)}`;
}

function incidentSk(incidentId) {
  return `INCIDENT#${incidentId}`;
}

function evidenceSk(incidentId, seq) {
  return `INCIDENT#${incidentId}#EVIDENCE#${String(seq).padStart(3, "0")}`;
}

function hypothesisSk(incidentId, seq) {
  return `INCIDENT#${incidentId}#HYPOTHESIS#${String(seq).padStart(10, "0")}`;
}

function itemTypeFromSk(sk) {
  const parts = sk.split("#");
  if (parts.length === 2) return "INCIDENT";
  if (parts[2] === "EVIDENCE") return "EVIDENCE";
  if (parts[2] === "HYPOTHESIS") return "HYPOTHESIS";
  return "UNKNOWN";
}

module.exports = { hourBucket, incidentSk, evidenceSk, hypothesisSk, itemTypeFromSk };

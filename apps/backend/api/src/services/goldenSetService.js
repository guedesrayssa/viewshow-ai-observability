/**
 * Única porta para a golden set (ADR-002/005) — leitura, nunca escrita.
 * goldenSetTable.js nem exporta put/update, então essa proteção é
 * estrutural: não tem como este arquivo escrever ali por acidente.
 */
const goldenSetTable = require("../db/goldenSetTable");

/** Mesma assinatura usada como case_id na curadoria (ver seed.js). */
function buildSignature({ component, deviceType, region }) {
  return `${component}#${deviceType}#${region}`;
}

async function findMatchingCase(incidentOrSignature) {
  const signature =
    typeof incidentOrSignature === "string" ? incidentOrSignature : buildSignature(incidentOrSignature);
  return goldenSetTable.get({ case_id: signature });
}

/**
 * Promove um caso confirmado por um humano à golden set (ADR-005). Só deve
 * ser chamado a partir da revisão de hipótese, nunca do orquestrador/agente
 * — ver comentário em db/goldenSetTable.js.
 */
async function promoteCase(incident, hypothesis, curatedBy) {
  const signature = buildSignature(incident);
  return goldenSetTable.putCurated({
    case_id: signature,
    incident_signature: signature,
    expected_hypothesis: hypothesis.text,
    expected_score: hypothesis.score,
    curated_by: curatedBy,
    curated_at: new Date().toISOString(),
    source_incident_id: incident.id,
  });
}

module.exports = { buildSignature, findMatchingCase, promoteCase };

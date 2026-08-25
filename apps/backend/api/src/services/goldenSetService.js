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

module.exports = { buildSignature, findMatchingCase };

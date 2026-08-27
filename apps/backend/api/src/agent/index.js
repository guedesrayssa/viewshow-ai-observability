/**
 * Agente (ADR-004): investiga só com o que o orquestrador entrega — nunca
 * acessa o banco direto. O score vem do módulo de ML (mockado por enquanto,
 * contrato fixo — ver services/mlService.js); a hipótese em texto ainda é
 * montada aqui a partir da evidência, até esse módulo também assumir isso.
 */
const mlService = require("../services/mlService");

function investigate({ incident, evidence }) {
  const analysis = mlService.analyze({ incident, evidence });

  const topEvidence = evidence[0];
  const hypothesis = topEvidence
    ? `Possível causa em ${incident.component}: ${topEvidence.description}`
    : `Investigação iniciada para ${incident.component}, ainda sem evidências suficientes`;

  return { hypothesis, score: analysis.confidence };
}

module.exports = { investigate };

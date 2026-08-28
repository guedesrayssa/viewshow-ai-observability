/**
 * Módulo de ML — mockado por enquanto (regra 6 do plano). Recebe qualquer
 * entrada e sempre devolve a mesma análise fixa; o contrato de entrada e
 * saída é o que importa aqui, pro time plugar o modelo de verdade depois
 * sem precisar mexer em quem chama isto (agent/index.js, rota /ml/analyze).
 */
function analyze(input) {
  return {
    anomalyScore: 0.82,
    label: "anomaly",
    confidence: 0.6,
    model: "mock-v0",
    receivedInputKeys: input && typeof input === "object" ? Object.keys(input) : [],
  };
}

module.exports = { analyze };

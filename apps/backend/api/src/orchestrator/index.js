/**
 * Orquestrador (ADR-004): resolve direto o que é determinístico (achou um
 * caso parecido na golden set) e só delega ao agente o que é ambíguo.
 * É o único lugar que decide a fonte do diagnóstico.
 */
const evidenceService = require("../services/evidenceService");
const goldenSetService = require("../services/goldenSetService");
const bedrockService = require("../services/bedrockService");
const agent = require("../agent");

async function diagnose(incidentId) {
  const bundle = await evidenceService.getIncidentBundle(incidentId);
  if (!bundle.incident) return null;

  const { incident, evidence } = bundle;
  const signature = goldenSetService.buildSignature(incident);
  const goldenCase = await goldenSetService.findMatchingCase(signature);

  let hypothesis;
  let score;
  let source;

  if (goldenCase) {
    hypothesis = goldenCase.expected_hypothesis;
    score = goldenCase.expected_score;
    source = "golden-set";
  } else {
    const agentResult = agent.investigate({ incident, evidence });
    hypothesis = agentResult.hypothesis;
    score = agentResult.score;
    source = "agent";
  }

  await evidenceService.saveHypothesis(incidentId, { text: hypothesis, score, source });

  const { explanation, explanationSource } = await bedrockService.explain({ hypothesis, score, evidence, source });

  return { incidentId, hypothesis, score, evidence, source, explanation, explanationSource };
}

module.exports = { diagnose };

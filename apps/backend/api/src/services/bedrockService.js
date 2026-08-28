/**
 * Ponto de extensão do Bedrock (ADR-004) — só redige a explicação em
 * linguagem natural, nunca decide hipótese/score. Se BEDROCK_ENABLED não
 * for "true", ou se a chamada falhar por qualquer motivo (bloqueio no
 * AWS Academy, throttle, timeout), cai no fallback por template. O
 * orquestrador sempre recebe uma explicação, nunca uma exceção daqui.
 */
const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";

function isEnabled() {
  return process.env.BEDROCK_ENABLED === "true";
}

function templateExplanation({ hypothesis, score, evidence, diagnosisSource }) {
  const originLabel =
    diagnosisSource === "golden-set" ? "caso já conhecido (golden set)" : "investigação do agente";
  const evidenceLine = evidence.length
    ? ` com base em ${evidence.length} evidência(s) coletada(s)`
    : "";
  return (
    `Hipótese: ${hypothesis}. Confiança: ${Math.round(score * 100)}%. ` +
    `Diagnóstico gerado a partir de ${originLabel}${evidenceLine}.`
  );
}

async function callBedrock({ hypothesis, score, evidence }) {
  // Import tardio: só toca o SDK do Bedrock quando a feature está ligada,
  // então falha de módulo/credencial nunca afeta quem roda com o flag off.
  const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: REGION });

  const prompt = [
    "Explique em 2-3 frases, em português, para um especialista de observabilidade,",
    `o incidente com hipótese "${hypothesis}" (score ${score}).`,
    `Evidências: ${evidence.map((item) => item.description).join("; ") || "nenhuma evidência registrada"}.`,
  ].join(" ");

  const response = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    }),
  );

  const payload = JSON.parse(Buffer.from(response.body).toString("utf-8"));
  return payload.content?.[0]?.text?.trim();
}

async function explain(diagnosis) {
  if (!isEnabled()) {
    return { explanation: templateExplanation(diagnosis), explanationSource: "template" };
  }

  try {
    const explanation = await callBedrock(diagnosis);
    if (!explanation) throw new Error("Resposta vazia do Bedrock");
    return { explanation, explanationSource: "bedrock" };
  } catch (error) {
    console.warn("Bedrock indisponível, usando fallback por template:", error.message);
    return { explanation: templateExplanation(diagnosis), explanationSource: "template" };
  }
}

module.exports = { explain };

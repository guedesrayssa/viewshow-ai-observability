import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createBedrockProvider,
  BedrockError,
  type ConverseInput,
  type ConverseOutput,
} from "../src/adapters/llm/bedrock-provider.js";

const PEDIDO = { systemPrompt: "sistema", userPrompt: "usuário" };

function converseFalso(saida: ConverseOutput | (() => Promise<ConverseOutput>)) {
  const chamadas: ConverseInput[] = [];
  const converse = async (input: ConverseInput) => {
    chamadas.push(input);
    return typeof saida === "function" ? saida() : saida;
  };
  return { converse, chamadas };
}

const SAIDA_BOA: ConverseOutput = {
  output: { message: { content: [{ text: '{"hypotheses":[]}' }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 300, outputTokens: 80 },
};

test("traduz a saída do Converse para o contrato do port", async () => {
  const { converse } = converseFalso(SAIDA_BOA);
  const provider = createBedrockProvider({ modelId: "modelo-x", converse });
  const resposta = await provider.generate(PEDIDO);

  assert.equal(resposta.text, '{"hypotheses":[]}');
  assert.equal(resposta.provider, "bedrock");
  assert.equal(resposta.modelId, "modelo-x");
  assert.equal(resposta.stopReason, "stop");
  assert.deepEqual(resposta.usage, { inputTokens: 300, outputTokens: 80 });
});

test("monta o comando no formato do Converse, com system separado", async () => {
  const { converse, chamadas } = converseFalso(SAIDA_BOA);
  const provider = createBedrockProvider({ modelId: "m", converse, maxTokens: 900, temperature: 0.3 });
  await provider.generate(PEDIDO);

  const entrada = chamadas[0];
  assert.equal(entrada?.system[0].text, "sistema");
  assert.equal(entrada?.messages[0].role, "user");
  assert.equal(entrada?.messages[0].content[0].text, "usuário");
  assert.equal(entrada?.inferenceConfig.maxTokens, 900);
  assert.equal(entrada?.inferenceConfig.temperature, 0.3);
});

test("max_tokens vira 'length' — a validação depende disso para rejeitar", async () => {
  const { converse } = converseFalso({ ...SAIDA_BOA, stopReason: "max_tokens" });
  const provider = createBedrockProvider({ modelId: "m", converse });
  assert.equal((await provider.generate(PEDIDO)).stopReason, "length");
});

test("stop_sequence conta como conclusão normal", async () => {
  const { converse } = converseFalso({ ...SAIDA_BOA, stopReason: "stop_sequence" });
  const provider = createBedrockProvider({ modelId: "m", converse });
  assert.equal((await provider.generate(PEDIDO)).stopReason, "stop");
});

test("resposta barrada por política nunca é tratada como conclusão", async () => {
  // content_filtered e guardrail_intervened interrompem a geração; aceitá-las
  // como "stop" faria um diagnóstico truncado passar por completo.
  for (const motivo of ["content_filtered", "guardrail_intervened"]) {
    const { converse } = converseFalso({ ...SAIDA_BOA, stopReason: motivo });
    const provider = createBedrockProvider({ modelId: "m", converse });
    assert.equal((await provider.generate(PEDIDO)).stopReason, "other", motivo);
  }
});

test("concatena apenas blocos de texto, ignorando outros tipos", async () => {
  const { converse } = converseFalso({
    output: { message: { content: [{ text: '{"a":' }, {}, { text: "1}" }] } },
    stopReason: "end_turn",
  });
  const provider = createBedrockProvider({ modelId: "m", converse });
  assert.equal((await provider.generate(PEDIDO)).text, '{"a":1}');
});

test("erro do SDK vira BedrockError nomeando o modelo", async () => {
  const provider = createBedrockProvider({
    modelId: "modelo-x",
    converse: async () => {
      throw new Error("ThrottlingException");
    },
  });
  await assert.rejects(() => provider.generate(PEDIDO), (erro: unknown) => {
    assert.ok(erro instanceof BedrockError);
    assert.match((erro as Error).message, /modelo-x.*ThrottlingException/);
    return true;
  });
});

test("saída sem blocos de conteúdo lança", async () => {
  const { converse } = converseFalso({ stopReason: "end_turn" });
  const provider = createBedrockProvider({ modelId: "m", converse });
  await assert.rejects(() => provider.generate(PEDIDO), BedrockError);
});

test("conteúdo vazio lança e informa o stopReason", async () => {
  const { converse } = converseFalso({
    output: { message: { content: [{ text: "   " }] } },
    stopReason: "max_tokens",
  });
  const provider = createBedrockProvider({ modelId: "m", converse });
  await assert.rejects(() => provider.generate(PEDIDO), /vazio.*max_tokens/);
});

test("usage sai vazio quando o Bedrock não informa contagem", async () => {
  const { converse } = converseFalso({
    output: { message: { content: [{ text: "{}" }] } },
    stopReason: "end_turn",
  });
  const provider = createBedrockProvider({ modelId: "m", converse });
  assert.deepEqual((await provider.generate(PEDIDO)).usage, {});
});

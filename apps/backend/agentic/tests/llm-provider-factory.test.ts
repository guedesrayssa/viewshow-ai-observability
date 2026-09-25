import { test } from "node:test";
import assert from "node:assert/strict";

import { createLlmProvider, ProviderConfigError } from "../src/bootstrap/llm-provider-factory.js";
import { AnalysisError } from "../src/worker/types.js";

test("recusa o provider falso fora de ambiente de teste", () => {
  for (const ambiente of ["production", "staging", "development", ""]) {
    assert.throws(
      () => createLlmProvider({ kind: "fake", modelId: "m", environment: ambiente }),
      ProviderConfigError,
      `ambiente "${ambiente}" não deveria autorizar o duplo`,
    );
  }
});

test("a mensagem de recusa explica a consequência, não só a regra", () => {
  assert.throws(
    () => createLlmProvider({ kind: "fake", modelId: "m", environment: "production" }),
    /diagnóstico inventado com aparência de real/,
  );
});

test("autoriza o provider falso em teste", () => {
  const provider = createLlmProvider({ kind: "fake", modelId: "m", environment: "test" });
  assert.equal(typeof provider.generate, "function");
});

test("ollama sem baseUrl é erro de configuração, não erro em tempo de chamada", () => {
  assert.throws(
    () => createLlmProvider({ kind: "ollama", modelId: "llama3.1", environment: "production" }),
    /exige baseUrl/,
  );
});

test("bedrock sem a função converse é erro de configuração", () => {
  assert.throws(
    () => createLlmProvider({ kind: "bedrock", modelId: "m", environment: "production" }),
    /exige a função `converse`/,
  );
});

test("none falha de forma permanente em qualquer ambiente, sem chamar modelo algum", async () => {
  for (const ambiente of ["production", "test"]) {
    const provider = createLlmProvider({ kind: "none", modelId: "none", environment: ambiente });
    await assert.rejects(
      () => provider.generate({ systemPrompt: "s", userPrompt: "u" }),
      (erro: unknown) => erro instanceof AnalysisError && erro.code === "LLM_DISABLED" && erro.permanent,
    );
  }
});

test("constrói ollama quando a configuração está completa", () => {
  const provider = createLlmProvider({
    kind: "ollama",
    modelId: "llama3.1",
    environment: "production",
    baseUrl: "http://localhost:11434",
  });
  assert.equal(typeof provider.generate, "function");
});

test("constrói bedrock quando a ligação com o SDK é fornecida", () => {
  const provider = createLlmProvider({
    kind: "bedrock",
    modelId: "modelo-x",
    environment: "production",
    converse: async () => ({ output: { message: { content: [{ text: "{}" }] } }, stopReason: "end_turn" }),
  });
  assert.equal(typeof provider.generate, "function");
});

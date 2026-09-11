import { test } from "node:test";
import assert from "node:assert/strict";

import { createLlmProvider, ProviderConfigError } from "../src/bootstrap/llm-provider-factory.js";

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

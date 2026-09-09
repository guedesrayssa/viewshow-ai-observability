import { test } from "node:test";
import assert from "node:assert/strict";

import { createOllamaProvider, OllamaError } from "../src/adapters/llm/ollama-provider.js";

const PEDIDO = { systemPrompt: "sistema", userPrompt: "usuário" };

/** fetch falso: devolve o que o teste mandar, e registra o que recebeu. */
function fakeFetch(resposta: Response | (() => Promise<Response>)) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init: unknown) => {
    chamadas.push({ url: String(url), init: init as RequestInit });
    return typeof resposta === "function" ? resposta() : resposta;
  }) as unknown as typeof globalThis.fetch;
  return { fn, chamadas };
}

function respostaOk(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CORPO_BOM = {
  message: { role: "assistant", content: '{"hypotheses":[]}' },
  done_reason: "stop",
  prompt_eval_count: 120,
  eval_count: 45,
};

test("traduz a resposta do Ollama para o contrato do port", async () => {
  const { fn } = fakeFetch(respostaOk(CORPO_BOM));
  const provider = createOllamaProvider({ baseUrl: "http://localhost:11434", model: "llama3.1", fetch: fn });
  const resposta = await provider.generate(PEDIDO);

  assert.equal(resposta.text, '{"hypotheses":[]}');
  assert.equal(resposta.provider, "ollama");
  assert.equal(resposta.modelId, "llama3.1");
  assert.equal(resposta.stopReason, "stop");
  assert.deepEqual(resposta.usage, { inputTokens: 120, outputTokens: 45 });
});

test("monta a requisição com as duas mensagens e o modo JSON", async () => {
  const { fn, chamadas } = fakeFetch(respostaOk(CORPO_BOM));
  const provider = createOllamaProvider({
    baseUrl: "http://localhost:11434",
    model: "llama3.1",
    maxTokens: 900,
    temperature: 0.2,
    fetch: fn,
  });
  await provider.generate(PEDIDO);

  assert.equal(chamadas[0]?.url, "http://localhost:11434/api/chat");
  const corpo = JSON.parse(String(chamadas[0]?.init.body));
  assert.equal(corpo.stream, false);
  assert.equal(corpo.format, "json");
  assert.equal(corpo.options.num_predict, 900);
  assert.equal(corpo.options.temperature, 0.2);
  assert.deepEqual(corpo.messages.map((m: { role: string }) => m.role), ["system", "user"]);
});

test("preserva done_reason 'length' — a validação depende disso para rejeitar", async () => {
  const { fn } = fakeFetch(respostaOk({ ...CORPO_BOM, done_reason: "length" }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  assert.equal((await provider.generate(PEDIDO)).stopReason, "length");
});

test("done_reason desconhecido vira 'other' em vez de virar 'stop'", async () => {
  const { fn } = fakeFetch(respostaOk({ ...CORPO_BOM, done_reason: "load" }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  assert.equal((await provider.generate(PEDIDO)).stopReason, "other");
});

test("HTTP de erro lança, e não devolve o corpo como se fosse resposta", async () => {
  const { fn } = fakeFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  await assert.rejects(() => provider.generate(PEDIDO), (erro: unknown) => {
    assert.ok(erro instanceof OllamaError);
    assert.match((erro as Error).message, /HTTP 502/);
    return true;
  });
});

test("corpo que não é JSON lança", async () => {
  const { fn } = fakeFetch(new Response("não sou json", { status: 200 }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  await assert.rejects(() => provider.generate(PEDIDO), OllamaError);
});

test("conteúdo vazio lança em vez de virar diagnóstico sem texto", async () => {
  const { fn } = fakeFetch(respostaOk({ message: { content: "   " }, done_reason: "stop" }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  await assert.rejects(() => provider.generate(PEDIDO), /sem conteúdo/);
});

test("resposta sem `message` lança", async () => {
  const { fn } = fakeFetch(respostaOk({ done_reason: "stop" }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  await assert.rejects(() => provider.generate(PEDIDO), OllamaError);
});

test("tempo limite lança mensagem própria, distinguível de falha de rede", async () => {
  const provider = createOllamaProvider({
    baseUrl: "http://x",
    model: "m",
    timeoutMs: 20,
    fetch: (async (_url: unknown, init: unknown) => {
      // Respeita o AbortSignal como um fetch real faria.
      const signal = (init as { signal?: AbortSignal }).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const erro = new Error("aborted");
          erro.name = "AbortError";
          reject(erro);
        });
      });
    }) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => provider.generate(PEDIDO), /não respondeu em 20 ms/);
});

test("falha de rede vira OllamaError apontando o endpoint", async () => {
  const provider = createOllamaProvider({
    baseUrl: "http://localhost:11434",
    model: "m",
    fetch: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => provider.generate(PEDIDO), /localhost:11434\/api\/chat/);
});

test("usage sai vazio quando o servidor não informa contagem", async () => {
  const { fn } = fakeFetch(respostaOk({ message: { content: "{}" }, done_reason: "stop" }));
  const provider = createOllamaProvider({ baseUrl: "http://x", model: "m", fetch: fn });
  assert.deepEqual((await provider.generate(PEDIDO)).usage, {});
});

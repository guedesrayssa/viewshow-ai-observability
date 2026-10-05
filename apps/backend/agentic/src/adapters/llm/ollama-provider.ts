/**
 * Adaptador Ollama — o provider real que roda sem depender da AWS.
 *
 * Existe por necessidade, não por preferência: Bedrock está bloqueado na conta
 * do AWS Academy, então este é o único caminho para ver a camada produzindo
 * diagnóstico de verdade. Num acionamento assíncrono, a latência de um modelo
 * local deixa de ser problema — ninguém está esperando na tela.
 *
 * Não silencia falha. O contrato do provider é "devolve texto ou lança": toda
 * resposta fora do esperado vira exceção, que a orquestração traduz em
 * `failed`. Um adaptador que devolvesse corpo vazio ou HTML de erro como se
 * fosse resposta faria o diagnóstico falhar mais tarde, em outro lugar, com
 * uma mensagem que não aponta para aqui.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from "../../ports/llm-provider.js";

export interface OllamaConfig {
  /** Ex.: http://localhost:11434. Dentro de container, o host não é localhost. */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * Teto de tokens gerados. Um diagnóstico com hipóteses ranqueadas e
   * explicações não cabe em poucas centenas; começar baixo produz resposta
   * cortada, que a validação rejeita como `TRUNCATED`.
   */
  readonly maxTokens?: number;
  /** Baixa de propósito: aqui se quer resposta estável, não criativa. */
  readonly temperature?: number;
  readonly timeoutMs?: number;
  /** Injetável para teste. Sem isso, testar exigiria um Ollama de pé. */
  readonly fetch?: typeof globalThis.fetch;
}

export class OllamaError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OllamaError";
  }
}

const PADROES = { maxTokens: 2500, temperature: 0.1, timeoutMs: 120_000 } as const;

/** `done_reason` do Ollama para o vocabulário do port. */
function mapStopReason(doneReason: unknown): LlmResponse["stopReason"] {
  if (doneReason === "stop") return "stop";
  // "length" significa que o teto de tokens cortou a geração. Precisa chegar
  // fielmente à validação, que rejeita resposta parcial em vez de aceitá-la.
  if (doneReason === "length") return "length";
  return "other";
}

export function createOllamaProvider(config: OllamaConfig): LlmProvider {
  const executar = config.fetch ?? globalThis.fetch;
  const maxTokens = config.maxTokens ?? PADROES.maxTokens;
  const temperature = config.temperature ?? PADROES.temperature;
  const timeoutMs = config.timeoutMs ?? PADROES.timeoutMs;
  const endpoint = new URL("/api/chat", config.baseUrl).toString();

  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let http: Response;
      try {
        http = await executar(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            // Instrui o servidor a só emitir JSON. Reduz muito a rejeição por
            // texto solto, mas não substitui a validação: JSON válido ainda
            // pode citar evidência inexistente.
            format: "json",
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt },
            ],
            options: { temperature, num_predict: maxTokens },
          }),
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name === "AbortError") {
          throw new OllamaError(`Ollama não respondeu em ${timeoutMs} ms.`, error);
        }
        throw new OllamaError(`Falha ao falar com o Ollama em ${endpoint}.`, error);
      }

      if (!http.ok) {
        // Trecho do corpo, não o corpo inteiro: erro de servidor às vezes
        // devolve página HTML, e despejá-la no log não ajuda ninguém.
        const trecho = (await http.text().catch(() => "")).slice(0, 200);
        clearTimeout(timer);
        throw new OllamaError(`Ollama respondeu HTTP ${http.status}: ${trecho}`);
      }

      let corpo: unknown;
      try {
        corpo = await http.json();
      } catch (error) {
        throw new OllamaError("Ollama respondeu com corpo que não é JSON.", error);
      } finally {
        clearTimeout(timer);
      }

      if (typeof corpo !== "object" || corpo === null) {
        throw new OllamaError("Ollama respondeu um JSON que não é objeto.");
      }

      const envelope = corpo as {
        message?: { content?: unknown; thinking?: unknown };
        done_reason?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      const texto = envelope.message?.content;

      if (typeof texto !== "string" || texto.trim() === "") {
        // O motivo da parada é o que distingue as causas possíveis, e sem ele
        // o erro obriga a adivinhar: "length" significa orçamento de tokens
        // esgotado (aumentar maxTokens), qualquer outro aponta para outro
        // problema. Modelos de raciocínio ainda gastam esse orçamento num
        // campo `thinking` separado, que não é o conteúdo da resposta.
        const pensou =
          typeof envelope.message?.thinking === "string" && envelope.message.thinking.trim() !== "";
        const gerados = typeof envelope.eval_count === "number" ? envelope.eval_count : "?";
        throw new OllamaError(
          `Ollama respondeu sem conteúdo em \`message.content\` ` +
            `(done_reason: ${String(envelope.done_reason)}, tokens gerados: ${gerados}` +
            `${pensou ? ", com raciocínio em `message.thinking`" : ""}).` +
            (envelope.done_reason === "length"
              ? " Orçamento de tokens esgotado antes da resposta: aumente maxTokens."
              : ""),
        );
      }

      return {
        text: texto,
        provider: "ollama",
        modelId: config.model,
        stopReason: mapStopReason(envelope.done_reason),
        usage: {
          ...(typeof envelope.prompt_eval_count === "number"
            ? { inputTokens: envelope.prompt_eval_count }
            : {}),
          ...(typeof envelope.eval_count === "number"
            ? { outputTokens: envelope.eval_count }
            : {}),
        },
      };
    },
  };
}

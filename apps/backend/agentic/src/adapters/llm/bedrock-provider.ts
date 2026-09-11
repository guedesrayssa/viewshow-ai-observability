/**
 * Adaptador Bedrock pela API Converse.
 *
 * Converse em vez de `InvokeModel`: o código anterior montava
 * `anthropic_version` na mão, o que prendia a camada a modelos Anthropic e
 * obrigava a reescrever o corpo da requisição a cada troca de família. Converse
 * é a interface comum entre os modelos suportados.
 *
 * O SDK da AWS NÃO é dependência deste pacote. O adaptador recebe um cliente
 * com a interface estreita abaixo, e quem integra — que já tem o SDK — faz a
 * ligação. Assim o núcleo continua sem dependência de runtime, e não se carrega
 * um SDK inteiro por um provider que hoje está bloqueado na conta do AWS
 * Academy. A troca é uma função de três linhas no ponto de composição:
 *
 * ```ts
 * const client = new BedrockRuntimeClient({ region, maxAttempts: 4 });
 * const provider = createBedrockProvider({
 *   modelId,
 *   converse: (input) => client.send(new ConverseCommand(input)),
 * });
 * ```
 */

import type { LlmProvider, LlmRequest, LlmResponse } from "../../ports/llm-provider.js";

/** Só o que a API Converse precisa receber. Espelha `ConverseCommandInput`. */
export interface ConverseInput {
  readonly modelId: string;
  readonly system: readonly [{ readonly text: string }];
  readonly messages: readonly [
    { readonly role: "user"; readonly content: readonly [{ readonly text: string }] },
  ];
  readonly inferenceConfig: { readonly maxTokens: number; readonly temperature: number };
}

/** Só o que se lê da resposta. Espelha `ConverseCommandOutput`, sem depender dele. */
export interface ConverseOutput {
  readonly output?: { readonly message?: { readonly content?: ReadonlyArray<{ readonly text?: string }> } };
  readonly stopReason?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface BedrockConfig {
  readonly modelId: string;
  readonly converse: (input: ConverseInput) => Promise<ConverseOutput>;
  /**
   * Um diagnóstico com hipóteses ranqueadas e explicações não cabe em poucas
   * centenas de tokens. Começar baixo produz resposta cortada, que a validação
   * rejeita como `TRUNCATED` — falha cara e confusa.
   */
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export class BedrockError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BedrockError";
  }
}

const PADROES = { maxTokens: 2500, temperature: 0.1 } as const;

/**
 * `stopReason` do Converse para o vocabulário do port.
 *
 * `content_filtered` e `guardrail_intervened` viram `other`, nunca `stop`:
 * são respostas interrompidas por política, e tratá-las como conclusão normal
 * faria um diagnóstico truncado passar por completo.
 */
function mapStopReason(stopReason: unknown): LlmResponse["stopReason"] {
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "stop";
  if (stopReason === "max_tokens") return "length";
  return "other";
}

export function createBedrockProvider(config: BedrockConfig): LlmProvider {
  const maxTokens = config.maxTokens ?? PADROES.maxTokens;
  const temperature = config.temperature ?? PADROES.temperature;

  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      let saida: ConverseOutput;
      try {
        saida = await config.converse({
          modelId: config.modelId,
          system: [{ text: request.systemPrompt }],
          messages: [{ role: "user", content: [{ text: request.userPrompt }] }],
          inferenceConfig: { maxTokens, temperature },
        });
      } catch (error) {
        // Throttling sob carga é esperado. O SDK já tenta de novo com espera
        // progressiva; esgotadas as tentativas, a exceção sobe e a mensagem
        // volta para a fila, que é onde a política de redrive decide.
        throw new BedrockError(
          `Falha ao invocar ${config.modelId} no Bedrock: ${(error as Error).message}`,
          error,
        );
      }

      const blocos = saida.output?.message?.content;
      if (!Array.isArray(blocos)) {
        throw new BedrockError("Bedrock respondeu sem blocos de conteúdo.");
      }

      // Concatena só os blocos de texto. Uma resposta pode trazer blocos de
      // outros tipos, e emendá-los às cegas produziria um JSON corrompido que
      // falharia mais adiante, com mensagem que não aponta para aqui.
      const texto = blocos
        .map((bloco) => bloco.text ?? "")
        .join("")
        .trim();

      if (texto === "") {
        throw new BedrockError(
          `Bedrock devolveu conteúdo vazio (stopReason: ${String(saida.stopReason)}).`,
        );
      }

      return {
        text: texto,
        provider: "bedrock",
        modelId: config.modelId,
        stopReason: mapStopReason(saida.stopReason),
        usage: {
          ...(typeof saida.usage?.inputTokens === "number" ? { inputTokens: saida.usage.inputTokens } : {}),
          ...(typeof saida.usage?.outputTokens === "number" ? { outputTokens: saida.usage.outputTokens } : {}),
        },
      };
    },
  };
}

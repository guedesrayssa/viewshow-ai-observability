/**
 * Seleção do provider, feita uma vez na inicialização.
 *
 * A trava que importa: `fake` é recusado fora de teste. Um duplo determinístico
 * que vaze para produção não quebra — ele responde, e a tela mostra um
 * diagnóstico inventado com aparência de real. É a pior classe de falha que
 * este módulo pode ter, e a única defesa barata é recusar na largada, quando
 * ainda dá para ver o erro no log de boot.
 */

import { createFakeProvider, type FakeProviderOptions } from "../adapters/llm/fake-provider.js";
import { createGroundedRulesProvider } from "../adapters/llm/grounded-rules-provider.js";
import { createOllamaProvider } from "../adapters/llm/ollama-provider.js";
import { createBedrockProvider, type ConverseInput, type ConverseOutput } from "../adapters/llm/bedrock-provider.js";
import type { LlmProvider } from "../ports/llm-provider.js";
import { AnalysisError } from "../worker/types.js";

export type LlmProviderKind = "bedrock" | "ollama" | "rules" | "fake" | "none";

export interface LlmProviderConfig {
  readonly kind: LlmProviderKind;
  readonly modelId: string;
  /** Ambiente de execução. Só "test" autoriza o provider falso. */
  readonly environment: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Obrigatório em `ollama`. Dentro de container, o host não é localhost. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * Obrigatório em `bedrock`. Vem de fora porque o SDK da AWS não é dependência
   * deste pacote — ver adapters/llm/bedrock-provider.ts.
   */
  readonly converse?: (input: ConverseInput) => Promise<ConverseOutput>;
  /** Só usado em `fake`. */
  readonly fakeOptions?: FakeProviderOptions;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.kind) {
    case "ollama": {
      if (!config.baseUrl) {
        throw new ProviderConfigError("Provider `ollama` exige baseUrl.");
      }
      return createOllamaProvider({
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      });
    }

    case "bedrock": {
      if (!config.converse) {
        throw new ProviderConfigError(
          "Provider `bedrock` exige a função `converse`; ligue o SDK no ponto de composição.",
        );
      }
      return createBedrockProvider({
        modelId: config.modelId,
        converse: config.converse,
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      });
    }

    case "none": {
      // Ambiente sem modelo de linguagem (Learner Lab não tem Bedrock). A
      // detecção e a previsão seguem; o diagnóstico falha de forma permanente e
      // fica registrado como `failed`, sem retentativa nem DLQ.
      return {
        generate: async () => {
          throw new AnalysisError("LLM_DISABLED", true);
        },
      };
    }

    case "rules":
      return createGroundedRulesProvider();

    case "fake": {
      if (config.environment !== "test") {
        throw new ProviderConfigError(
          `Provider \`fake\` só é permitido em ambiente de teste; recebido "${config.environment}". ` +
            "Um duplo determinístico em produção devolveria diagnóstico inventado com aparência de real.",
        );
      }
      return createFakeProvider(config.fakeOptions ?? {});
    }

    default: {
      // Exaustividade verificada em tempo de compilação: um `kind` novo sem
      // caso aqui vira erro de tipo, não erro em produção.
      const inesperado: never = config.kind;
      throw new ProviderConfigError(`Provider não suportado: ${String(inesperado)}`);
    }
  }
}

/**
 * Provider determinístico para teste automatizado. Nunca serve diagnóstico
 * real — a composição da aplicação deve recusar selecioná-lo fora de teste.
 *
 * É configurável em vez de esperto: quem escreve o teste diz exatamente o que
 * o modelo "responde". Um duplo que tenta adivinhar uma resposta plausível a
 * partir do prompt acaba testando a própria esperteza, e some justamente nos
 * casos que mais importam — resposta truncada, JSON quebrado, evidência
 * inventada.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from "../../ports/llm-provider.js";

/** Forma de uma hipótese como o modelo a escreve — sem `id` e sem `rank`. */
export interface FakeHypothesis {
  readonly title: string;
  readonly explanation: string;
  readonly confidence: number;
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds?: readonly string[];
  readonly missingEvidence?: readonly string[];
}

export interface FakeProviderOptions {
  /** Resposta bem formada montada a partir destas hipóteses. */
  readonly hypotheses?: readonly FakeHypothesis[];
  /** Texto cru, para exercitar JSON inválido, cerca de código e afins. */
  readonly rawText?: string;
  readonly stopReason?: LlmResponse["stopReason"];
  /** Erro lançado no lugar de responder, para o caminho de falha do provider. */
  readonly throws?: Error;
  /** Atraso simulado, para exercitar tempo limite. */
  readonly delayMs?: number;
}

export interface FakeProvider extends LlmProvider {
  /** Requisições recebidas, na ordem. Permite asserção sobre o prompt montado. */
  readonly calls: readonly LlmRequest[];
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const calls: LlmRequest[] = [];

  const text =
    options.rawText ??
    JSON.stringify({
      hypotheses: (options.hypotheses ?? []).map((h) => ({
        title: h.title,
        explanation: h.explanation,
        confidence: h.confidence,
        supportingEvidenceIds: h.supportingEvidenceIds,
        contradictingEvidenceIds: h.contradictingEvidenceIds ?? [],
        missingEvidence: h.missingEvidence ?? [],
      })),
    });

  return {
    calls,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.throws) throw options.throws;
      return {
        text,
        provider: "fake",
        modelId: "fake-deterministic",
        stopReason: options.stopReason ?? "stop",
      };
    },
  };
}

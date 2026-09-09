/**
 * Modelo de diagnóstico da camada agêntica.
 *
 * O vocabulário aqui segue `artefatos/arquitetura/analise-e-ia.md` v1.1, que se
 * declara fonte normativa da orquestração do diagnóstico. Onde este módulo
 * tinha nome próprio para a mesma coisa, o nome do documento prevalece — dois
 * vocabulários para um conceito custam mais do que qualquer ganho de precisão.
 */

import type { MlSignal } from "./ml-result.js";

/**
 * Estados do diagnóstico (analise-e-ia.md §10).
 *
 * `pending` cobre tanto "aguardando processamento" quanto "dados
 * insuficientes": é onde cai o diferimento decidido pelo gate de qualidade, e
 * os motivos ficam em `reasons`.
 *
 * Não existe estado "inconclusivo" aqui de propósito. Inconclusivo é decisão
 * HUMANA sobre uma hipótese (§9), não veredito da máquina: quando o modelo
 * responde e nada convence, as hipóteses fracas ainda vão para revisão, com um
 * aviso. Quem declara que não deu para concluir é a pessoa que olhou.
 */
export type DiagnosisStatus = "pending" | "processing" | "ready" | "failed";

/**
 * Estado da revisão humana de uma hipótese (§9). Resultado da IA nasce
 * `pending`, e a interface precisa deixar claro que a causa ainda não foi
 * confirmada. `confirmed` e `refuted` são finais; `inconclusive` admite nova
 * revisão.
 */
export type HypothesisReviewStatus = "pending" | "confirmed" | "refuted" | "inconclusive";

/** Quem produziu o diagnóstico. Um caso curado não tem modelo por trás. */
export type DiagnosisSource = "golden-set" | "llm";

/** Tipos de evento da fila de análise (§3 e §4). */
export type InvestigationTrigger =
  /** Janela de 15 min: anomalia efetivamente observada. */
  | "ANOMALY_DETECTION"
  /** Janela horária: risco previsto para a hora seguinte, ainda sem incidente. */
  | "QOE_FORECAST"
  /** Reexecução pedida por uma pessoa. Não altera a execução anterior. */
  | "REANALYSIS_REQUESTED";

/**
 * Motivo estruturado. Código para decidir, texto para ler. Serve ao
 * diferimento, à falha e ao aviso de confiança baixa — a forma é a mesma, e um
 * campo só evita que metade dos consumidores esqueça de olhar o outro.
 */
export interface Reason {
  readonly code: string;
  readonly detail: string;
}

export interface Hypothesis {
  readonly id: string;
  /** 1 é a mais provável. Ranque é do agente, não do modelo de ML. */
  readonly rank: number;
  readonly title: string;
  readonly explanation: string;
  /**
   * Confiança do agente na hipótese, de 0 a 1. Nunca preenchida com o score do
   * detector: um mede quão anômalo é o sinal, o outro quanto o agente acredita
   * nesta explicação para aquele sinal.
   */
  readonly confidence: number;
  /**
   * Evidências de apoio. Toda id precisa existir no pacote carregado — é essa
   * checagem, e não a instrução no prompt, que impede evidência inventada.
   */
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
  readonly missingEvidence: readonly string[];
  /** Sempre `pending` ao nascer: só a revisão humana muda isto (§9). */
  readonly reviewStatus: HypothesisReviewStatus;
}

export interface Diagnosis {
  readonly diagnosisId: string;
  /** Nulo em `QOE_FORECAST`: previsão de risco não é incidente observado (§3). */
  readonly incidentId: string | null;
  readonly trigger: InvestigationTrigger;
  readonly status: DiagnosisStatus;
  /**
   * Versão do conjunto de dados usada na execução (§8). Preservada durante toda
   * a execução mesmo que outra seja ativada em paralelo — é o que permite
   * reproduzir e comparar uma análise depois.
   */
  readonly datasetVersion: string;
  /** O sinal que disparou, copiado sem alteração. */
  readonly signal: MlSignal;
  /** Vazio em `pending` e `failed`. */
  readonly hypotheses: readonly Hypothesis[];
  /**
   * Motivos do diferimento em `pending`, da quebra em `failed`, hipóteses
   * descartadas e aviso de confiança baixa em `ready`. Vazio quando não há o
   * que ressalvar.
   */
  readonly reasons: readonly Reason[];
  readonly source: DiagnosisSource | null;
  readonly model: { readonly provider: string; readonly modelId: string; readonly promptVersion: string } | null;
  readonly createdAt: string;
}

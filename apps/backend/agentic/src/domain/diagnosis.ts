/**
 * Modelo de diagnóstico da camada agêntica.
 *
 * Reúne três fontes que não concordavam entre si:
 *  - o fluxograma do parceiro, que tem um caminho "diagnóstico pendente" e
 *    duas entradas (preventiva e reativa);
 *  - a especificação do serviço de RCA, que tem hipóteses ranqueadas,
 *    ancoragem em evidências e a distinção entre falhar e não concluir;
 *  - o notebook de ML, que mostra por que "confiança" e "score de anomalia"
 *    são coisas diferentes e não podem ser fundidas.
 */

import type { MlSignal } from "./ml-result.js";

/**
 * Estados possíveis. `deferred` e `inconclusive` NÃO são sinônimos, e a
 * diferença é de custo: `deferred` é decidido ANTES de chamar o LLM, porque os
 * dados não sustentam investigação; `inconclusive` é decidido DEPOIS, porque o
 * LLM respondeu e nada atingiu o piso. Com falso positivo de 63% a 71% nos
 * detectores, tratar os dois como o mesmo estado significa pagar inferência em
 * cerca de dois terços dos disparos para escrever "não sei".
 *
 * `failed` é o único que deve gerar alarme: significa que o sistema não
 * funcionou, e não que ele funcionou e não tinha o que dizer.
 */
export type DiagnosisStatus =
  | "not_started"
  | "processing"
  | "deferred"
  | "ready"
  | "inconclusive"
  | "failed";

/** Quem produziu o diagnóstico. Um caso curado não tem modelo por trás. */
export type DiagnosisSource = "golden-set" | "llm";

/** O que motivou a investigação. Espelha as duas entradas do fluxograma. */
export type InvestigationTrigger =
  /** Detector acusou anomalia sobre um incidente já materializado. */
  | "reactive"
  /** Previsão de degradação: ainda não há incidente, só risco. */
  | "preventive";

export interface Hypothesis {
  readonly id: string;
  /** 1 é a mais provável. Ranque é do agente, não do modelo de ML. */
  readonly rank: number;
  readonly title: string;
  readonly explanation: string;
  /**
   * Confiança do agente na hipótese, de 0 a 1. É valor DO AGENTE e nunca deve
   * ser preenchido com o score do detector: um mede quão anômalo o sinal é, o
   * outro mede quanto o agente acredita nesta explicação para aquele sinal.
   */
  readonly confidence: number;
  /**
   * Evidências que sustentam a hipótese. Toda id aqui precisa existir no
   * pacote carregado — é essa checagem, e não a instrução no prompt, que
   * impede o modelo de citar evidência inventada.
   */
  readonly supportingEvidenceIds: readonly string[];
  /** Evidências que contradizem. Um agente honesto às vezes tem alguma. */
  readonly contradictingEvidenceIds: readonly string[];
  /** O que faltou olhar. Vira fila de coleta, não enfeite de relatório. */
  readonly missingEvidence: readonly string[];
}

/** Por que o diagnóstico não foi tentado. Sempre acompanha `deferred`. */
export interface DeferralReason {
  readonly code: string;
  readonly detail: string;
}

export interface Diagnosis {
  readonly diagnosisId: string;
  /** Ausente no caminho preventivo: previsão de risco não tem incidente. */
  readonly incidentId: string | null;
  readonly trigger: InvestigationTrigger;
  readonly status: DiagnosisStatus;
  /**
   * O sinal que disparou tudo, copiado sem alteração. Preservar o score do
   * detector separado da confiança do agente é o que permite auditar depois
   * se o agente concordou ou discordou do modelo.
   */
  readonly signal: MlSignal;
  /** Vazio em `deferred`, `failed` e `inconclusive`. */
  readonly hypotheses: readonly Hypothesis[];
  /** Presente apenas em `deferred`. */
  readonly deferralReasons: readonly DeferralReason[];
  /** Ausente quando source é "golden-set": nenhum modelo produziu o resultado. */
  readonly source: DiagnosisSource | null;
  readonly model: { readonly provider: string; readonly modelId: string; readonly promptVersion: string } | null;
  readonly createdAt: string;
}

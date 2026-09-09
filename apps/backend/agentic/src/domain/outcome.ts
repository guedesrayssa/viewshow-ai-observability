/**
 * Desfecho de uma investigação que chegou até o modelo e voltou válida.
 *
 * Separado da validação de propósito: "o modelo respondeu no formato certo" e
 * "a resposta é boa o bastante para mostrar a alguém" são perguntas
 * diferentes, com donos diferentes. A primeira é contrato e não se negocia; a
 * segunda é política e vai mudar conforme a operação aprender.
 */

import type { DiagnosisStatus, Hypothesis } from "./diagnosis.js";

/**
 * Piso de confiança para um diagnóstico ser apresentado como conclusivo.
 *
 * Não derivado do notebook: lá a confiança do agente não existe (os modelos
 * produzem score de anomalia, que é outra coisa). É ponto de partida, a
 * recalibrar quando houver revisão humana suficiente para medir com que
 * frequência hipóteses de cada faixa são confirmadas.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Classifica entre `ready` e `inconclusive`.
 *
 * `inconclusive` não é falha: o sistema funcionou, chamou o modelo, recebeu
 * resposta válida e nada nela se sustenta o bastante. Guardar isso separado de
 * `failed` é o que permite alarmar só quando algo realmente quebrou.
 */
export function classifyOutcome(
  hypotheses: readonly Hypothesis[],
  floor: number = DEFAULT_CONFIDENCE_FLOOR,
): Extract<DiagnosisStatus, "ready" | "inconclusive"> {
  return hypotheses.some((h) => h.confidence >= floor) ? "ready" : "inconclusive";
}

/**
 * Reordena por confiança e reatribui o ranque.
 *
 * O modelo devolve as hipóteses em alguma ordem, mas nada garante que seja a
 * ordem de confiança que ele mesmo atribuiu. Ordenar aqui faz `rank` significar
 * sempre a mesma coisa, em vez de refletir a ordem em que o texto saiu.
 * Empate mantém a ordem original, que é a preferência declarada pelo modelo.
 */
export function rankByConfidence(hypotheses: readonly Hypothesis[]): readonly Hypothesis[] {
  return [...hypotheses]
    .map((h, indice) => ({ h, indice }))
    .sort((a, b) => b.h.confidence - a.h.confidence || a.indice - b.indice)
    .map(({ h }, indice) => ({ ...h, rank: indice + 1 }));
}

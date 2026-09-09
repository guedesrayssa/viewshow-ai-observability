/**
 * Avaliação da resposta que voltou válida do modelo.
 *
 * Separado da validação de propósito: "o modelo respondeu no formato certo" e
 * "a resposta é boa o bastante" são perguntas diferentes. A primeira é
 * contrato e não se negocia; a segunda é política e vai mudar conforme a
 * operação aprender.
 */

import type { Hypothesis, Reason } from "./diagnosis.js";

/**
 * Piso abaixo do qual o diagnóstico recebe uma ressalva de confiança baixa.
 *
 * Não derivado do notebook: lá a confiança do agente não existe (os modelos
 * produzem score de anomalia, que é outra coisa). É ponto de partida, a
 * recalibrar quando houver revisão humana suficiente para medir com que
 * frequência hipóteses de cada faixa acabam confirmadas.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Ressalva quando nenhuma hipótese alcança o piso.
 *
 * Não vira estado do diagnóstico: por analise-e-ia.md §9 e §10, hipótese
 * validada vai para revisão humana, e "inconclusivo" é veredito de pessoa, não
 * de máquina. O que a máquina faz é entregar as hipóteses fracas COM o aviso,
 * em vez de escondê-las ou de decidir sozinha que não deu.
 */
export function lowConfidenceWarning(
  hypotheses: readonly Hypothesis[],
  floor: number = DEFAULT_CONFIDENCE_FLOOR,
): Reason | null {
  if (hypotheses.some((h) => h.confidence >= floor)) return null;
  const maior = Math.max(...hypotheses.map((h) => h.confidence));
  return {
    code: "BELOW_CONFIDENCE_FLOOR",
    detail: `Maior confiança é ${maior.toFixed(2)}; piso para diagnóstico firme é ${floor.toFixed(2)}.`,
  };
}

/**
 * Reordena por confiança e reatribui o ranque.
 *
 * O modelo devolve as hipóteses em alguma ordem, mas nada garante que seja a
 * ordem de confiança que ele mesmo atribuiu. Ordenar aqui faz `rank` significar
 * sempre a mesma coisa. Empate mantém a ordem original, que é a preferência
 * declarada pelo modelo.
 */
export function rankByConfidence(hypotheses: readonly Hypothesis[]): readonly Hypothesis[] {
  return [...hypotheses]
    .map((h, indice) => ({ h, indice }))
    .sort((a, b) => b.h.confidence - a.h.confidence || a.indice - b.indice)
    .map(({ h }, indice) => ({ ...h, rank: indice + 1 }));
}

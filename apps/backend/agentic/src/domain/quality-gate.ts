/**
 * Gate de qualidade mínima — a caixa "Dados com qualidade suficiente?" do
 * fluxograma do parceiro, executada ANTES de acionar o agente.
 *
 * Por que antes: o detector do notebook tem recall de 100% sobre os quatro
 * incidentes avaliáveis, mas falso positivo de 71% (série isolada) a 63%
 * (multivariado). Sem gate, cerca de dois terços dos disparos consomem uma
 * chamada de LLM para produzir um diagnóstico sobre ruído. O gate não melhora
 * o detector; ele impede que o custo do detector vire custo de inferência.
 *
 * Função pura, sem E/S: é testável sem AWS, sem rede e sem banco, e é o único
 * lugar onde a política de "vale a pena investigar isto?" está escrita.
 */

import { exceedsThreshold, relativeMargin, type MlSignal } from "./ml-result.js";
import type { DeferralReason } from "./diagnosis.js";

export type GateReasonCode =
  /** Sem evidência, o agente só consegue repetir o enunciado do incidente. */
  | "NO_EVIDENCE"
  /** Baseline calculada sobre histórico curto demais para ser confiável. */
  | "INSUFFICIENT_HISTORY"
  /** Nenhuma entidade ligada ao serviço do incidente foi observada. */
  | "UNSCOPED_ENTITIES"
  /** O sinal não passou do próprio limiar; não deveria ter chegado aqui. */
  | "SIGNAL_BELOW_THRESHOLD"
  /** Passou, mas raspando — a faixa onde mora a maior parte do falso positivo. */
  | "MARGIN_TOO_THIN"
  /** Sinal velho demais: o diagnóstico descreveria um sistema que já mudou. */
  | "STALE_SIGNAL";

export interface GateInput {
  readonly signal: MlSignal;
  /** Quantas evidências o coletor conseguiu reunir para este incidente. */
  readonly evidenceCount: number;
  /** Histórico disponível para a baseline no momento da avaliação. */
  readonly history: { readonly days: number; readonly points: number };
  /**
   * Entidades observadas, separadas entre as ligadas ao campo `services` do
   * incidente e o total. Checar disparo em qualquer série do universo é erro
   * de comparações múltiplas: no notebook isso sozinho produzia ~92% de falso
   * positivo, corrigido ao escopar às entidades do próprio serviço (seção 8).
   */
  readonly entities: { readonly scoped: number; readonly observed: number };
  readonly signalAgeMinutes: number;
}

export interface GatePolicy {
  readonly minEvidence: number;
  /** Aquecimento da baseline, em dias. */
  readonly minHistoryDays: number;
  /** Pontos mínimos na janela retroativa. */
  readonly minHistoryPoints: number;
  /** Margem relativa mínima além do limiar. */
  readonly minRelativeMargin: number;
  readonly maxSignalAgeMinutes: number;
}

/**
 * Padrões. Os três primeiros vêm do notebook e não devem ser mexidos sem
 * refazer a calibração; os dois últimos são política operacional nossa, e
 * estão aqui explicitamente para serem ajustados com dado de produção.
 */
export const DEFAULT_POLICY: GatePolicy = {
  // Um sinal sem evidência já é o defeito que existe hoje: o agente devolve
  // "ainda sem evidências suficientes" acompanhado de um score, o que afirma
  // confiança sobre nada.
  minEvidence: 1,
  // WARMUP_DAYS do notebook: antes disso a baseline dos primeiros dias sairia
  // calculada sobre quase nenhum histórico.
  minHistoryDays: 3,
  // MIN_POINTS do notebook: abaixo disso mediana e MAD ficam instáveis.
  minHistoryPoints: 96,
  // Não derivado do notebook. Ponto de partida deliberadamente conservador,
  // a recalibrar quando houver falso positivo medido em produção.
  minRelativeMargin: 0.1,
  // Idem: uma hora é o passo do bucket de QoE.
  maxSignalAgeMinutes: 60,
};

export type GateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly DeferralReason[] };

/**
 * Avalia se os dados sustentam uma investigação.
 *
 * Devolve TODOS os motivos, não só o primeiro: quem lê um diagnóstico diferido
 * precisa saber tudo que faltou para poder corrigir de uma vez, e não
 * descobrir o próximo impedimento a cada nova tentativa.
 */
export function evaluateQuality(
  input: GateInput,
  policy: GatePolicy = DEFAULT_POLICY,
): GateVerdict {
  const reasons: DeferralReason[] = [];

  if (input.evidenceCount < policy.minEvidence) {
    reasons.push({
      code: "NO_EVIDENCE",
      detail: `${input.evidenceCount} evidência(s) reunida(s); mínimo é ${policy.minEvidence}.`,
    });
  }

  if (input.history.days < policy.minHistoryDays || input.history.points < policy.minHistoryPoints) {
    reasons.push({
      code: "INSUFFICIENT_HISTORY",
      detail:
        `Baseline sobre ${input.history.days}d e ${input.history.points} ponto(s); ` +
        `mínimo é ${policy.minHistoryDays}d e ${policy.minHistoryPoints} pontos.`,
    });
  }

  // A previsão de QoE é por sinal, não por serviço: ela não tem entidades para
  // escopar, e cobrar isso dela reprovaria todo o caminho preventivo.
  if (input.signal.detector !== "qoe-forecast" && input.entities.scoped < 1) {
    reasons.push({
      code: "UNSCOPED_ENTITIES",
      detail:
        `Nenhuma das ${input.entities.observed} entidade(s) observada(s) pertence ao ` +
        "serviço do incidente; disparo provavelmente é ruído de outra série.",
    });
  }

  if (!exceedsThreshold(input.signal)) {
    reasons.push({
      code: "SIGNAL_BELOW_THRESHOLD",
      detail: `Score ${input.signal.score} não passa do limiar ${input.signal.threshold.value}.`,
    });
  } else {
    const margem = relativeMargin(input.signal);
    if (margem < policy.minRelativeMargin) {
      reasons.push({
        code: "MARGIN_TOO_THIN",
        detail:
          `Margem de ${(margem * 100).toFixed(1)}% além do limiar; ` +
          `mínimo é ${(policy.minRelativeMargin * 100).toFixed(1)}%.`,
      });
    }
  }

  if (input.signalAgeMinutes > policy.maxSignalAgeMinutes) {
    reasons.push({
      code: "STALE_SIGNAL",
      detail: `Sinal observado há ${input.signalAgeMinutes} min; limite é ${policy.maxSignalAgeMinutes} min.`,
    });
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

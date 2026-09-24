/**
 * Contrato de saída dos modelos de ML, como eles REALMENTE produzem —
 * derivado de artefatos/extras/notebooks/argus_algoritmo.ipynb, não inventado.
 *
 * Não existe aqui um `anomalyScore` de 0 a 1 nem um `confidence`: nenhum dos
 * quatro métodos do notebook emite qualquer um dos dois. Cada detector tem
 * escala própria e limiar próprio. Um z robusto de 4,2 e uma distância de
 * Mahalanobis de 4,2 não significam a mesma coisa, e uma pontuação de episódio
 * não tem teto — normalizar os três para "0,82" perde a informação de quão
 * longe do normal cada um está.
 *
 * Por isso todo sinal carrega o limiar contra o qual foi comparado. Quem
 * consome nunca precisa saber a escala para decidir se passou.
 */

/** Escala do score. Cada uma vem de uma seção específica do notebook. */
export type ScoreScale =
  /** |z| por mediana/MAD com baseline retroativa de 7 d (seções 7 a 10). */
  | "robust-z"
  /** z_pico x duração x peso de tier (seção 10). Sem teto superior. */
  | "episode-score"
  /** Distância multivariada com encolhimento Ledoit-Wolf (seção 12). */
  | "mahalanobis"
  /** Risco previsto de degradação, normalizado de 0 a 1 (analise-e-ia.md §7). */
  | "qoe-risk";

/**
 * De onde saiu o limiar. Um percentil do treino não é um número mágico, e
 * registrar a origem é o que permite recalibrar sem arqueologia depois.
 */
export type ThresholdOrigin =
  /** Escolhido por leave-one-incident-out sobre os rótulos confiáveis (seção 8). */
  | "loio-calibration"
  /** Percentil calculado só no conjunto de treino, nunca no teste (seções 11 e 12). */
  | "train-percentile"
  /** Fixado à mão. Exige justificativa fora do código. */
  | "manual";

export interface Threshold {
  readonly value: number;
  readonly origin: ThresholdOrigin;
  /** Preenchido quando origin === "train-percentile" (ex.: 99 para o p99). */
  readonly percentile?: number;
}

/** Identificação do que produziu o sinal. Sem isso não há fingerprint estável. */
export interface ModelIdentity {
  readonly name: string;
  /** Versão do modelo/config congelada. Entra no fingerprint de idempotência. */
  readonly version: string;
}

interface BaseSignal {
  readonly model: ModelIdentity;
  readonly scale: ScoreScale;
  readonly score: number;
  readonly threshold: Threshold;
  /** Quando a janela observada terminou. ISO 8601. */
  readonly observedAt: string;
}

/**
 * Detector por série isolada. Recall de 100% nos 4 incidentes avaliáveis, mas
 * 71% de falso positivo — a maior parte concentrada em uma única entidade
 * cronicamente instável (seção 14). É o motivo de existir um gate de qualidade.
 */
export interface UnivariateSignal extends BaseSignal {
  readonly detector: "univariate-robust-z";
  readonly scale: "robust-z" | "episode-score";
  readonly series: { readonly source: string; readonly entity: string; readonly metric: string };
}

/** Detector multivariado. Mesmo recall, falso positivo de 63% (seção 14). */
export interface MultivariateSignal extends BaseSignal {
  readonly detector: "multivariate-mahalanobis";
  readonly scale: "mahalanobis";
  /** Séries observadas simultaneamente na matriz. */
  readonly dimensions: number;
}

/**
 * Previsão de degradação de QoE. Caminho preventivo: não há incidente ainda,
 * então o alvo é a janela, não um incidentId.
 *
 * Formato conforme analise-e-ia.md §7. Aqui `score` é o `riskScore`, que é
 * normalizado de 0 a 1 — diferente dos detectores de anomalia, cujas escalas
 * não são. É por isso que o limiar viaja junto de todo sinal: quem consome
 * nunca precisa saber qual caso é qual.
 */
export interface QoeForecastSignal extends BaseSignal {
  readonly detector: "qoe-forecast";
  readonly scale: "qoe-risk";
  /** Valor previsto da métrica, na unidade original (ex.: buffer ratio). */
  readonly predictedValue: number;
  readonly riskLevel: "NORMAL" | "ELEVATED" | "HIGH";
  /** Janela para a qual o risco foi previsto. */
  readonly targetWindow: { readonly start: string; readonly end: string };
  /** Permanece verdadeiro até a validação prospectiva aprovar o modelo. */
  readonly experimental?: true;
}

export type MlSignal = UnivariateSignal | MultivariateSignal | QoeForecastSignal;

/** O sinal passou do próprio limiar? Única comparação válida sem saber a escala. */
export function exceedsThreshold(signal: MlSignal): boolean {
  return signal.score > signal.threshold.value;
}

/**
 * Quanto o score passou do limiar, em fração do próprio limiar.
 *
 * Scores brutos de detectores diferentes não são comparáveis; esta razão é,
 * porque cada um é medido contra a própria régua. 0 significa exatamente em
 * cima do limiar, 0,5 significa 50% além dele. Negativo significa abaixo.
 */
export function relativeMargin(signal: MlSignal): number {
  const limiar = signal.threshold.value;
  // Limiar zero ou negativo tornaria a razão sem sentido (divisão por zero ou
  // inversão de sinal). Nenhum dos quatro detectores produz isso, mas o tipo
  // permite, e devolver 0 aqui faz o gate tratar o caso como "sem margem".
  if (limiar <= 0) return 0;
  return (signal.score - limiar) / limiar;
}

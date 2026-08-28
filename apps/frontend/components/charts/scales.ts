/**
 * @file scales.ts
 * Escalas e marcas dos gráficos.
 *
 * O que separa um gráfico de uma ilustração é o eixo: valores precisam cair em
 * marcas redondas, e a mesma série precisa ocupar o mesmo lugar toda vez que é
 * lida. Estas funções são a única fonte dessas decisões, para que os cinco
 * gráficos do painel não escolham escalas diferentes para o mesmo dado.
 */

/** Área útil do desenho, descontadas as margens dos eixos. */
export type Plot = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type PlotMargin = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Calcula a área de plotagem a partir do tamanho medido do contêiner. */
export function toPlot(width: number, height: number, margin: PlotMargin): Plot {
  return {
    left: margin.left,
    right: width - margin.right,
    top: margin.top,
    bottom: height - margin.bottom,
    width: Math.max(0, width - margin.left - margin.right),
    height: Math.max(0, height - margin.top - margin.bottom),
  };
}

/**
 * Arredonda o teto do eixo para a próxima marca redonda.
 *
 * Um eixo que termina em 24.837 obriga a pessoa a ler o número para entender a
 * altura; terminando em 25 mil, a altura já diz.
 *
 * @example
 * niceMax(24837); // 25000
 * niceMax(4.9);   // 5
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;

  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;

  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Marcas do eixo vertical, do zero ao teto.
 *
 * @param max - Teto do eixo, já arredondado por `niceMax`.
 * @param count - Quantidade de intervalos.
 *
 * @example
 * axisTicks(400, 4); // [0, 100, 200, 300, 400]
 */
export function axisTicks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, index) => (max / count) * index);
}

/**
 * Passo entre os rótulos do eixo horizontal.
 *
 * Rótulos que se tocam viram uma faixa cinza ilegível. O passo cresce até que
 * caibam com folga na largura disponível.
 *
 * @param total - Quantidade de pontos da série.
 * @param width - Largura da área de plotagem, em pixels.
 * @param minGap - Espaço mínimo entre dois rótulos, em pixels.
 *
 * @example
 * labelStep(24, 300, 52); // 5
 */
export function labelStep(total: number, width: number, minGap = 52): number {
  if (total <= 1 || width <= 0) return 1;

  const perLabel = width / (total - 1);
  return Math.max(1, Math.ceil(minGap / Math.max(perLabel, 1)));
}

/** Constrói o caminho de uma linha a partir dos pontos já projetados. */
export function toLinePath(points: { x: number; y: number }[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
}

/** Fecha a linha na base do gráfico, para o preenchimento de área. */
export function toAreaPath(
  points: { x: number; y: number }[],
  baseline: number,
): string {
  if (points.length === 0) return "";

  const first = points[0];
  const last = points[points.length - 1];
  return `${toLinePath(points)} L${last.x} ${baseline} L${first.x} ${baseline} Z`;
}

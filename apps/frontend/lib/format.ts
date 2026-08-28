/**
 * @file format.ts
 * Formatação de números do painel.
 *
 * Reunida aqui para que o mesmo valor seja escrito do mesmo jeito em todas as
 * telas: "12,4 mil" nunca aparece como "12.400" em um cartão e "12,4k" em
 * outro. Todas as funções usam a convenção brasileira, com vírgula decimal.
 */

/** Locale único do produto. */
const LOCALE = "pt-BR";

/**
 * Número inteiro com separador de milhar.
 *
 * @example
 * formatInteger(12400); // "12.400"
 */
export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString(LOCALE);
}

/**
 * Número com casas decimais fixas.
 *
 * @example
 * formatDecimal(4.92, 1); // "4,9"
 */
export function formatDecimal(value: number, digits = 1): string {
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Número grande abreviado, no padrão dos cartões de impacto.
 *
 * @example
 * formatCompact(12400); // "12,4 mil"
 * formatCompact(2480000); // "2,5 mi"
 */
export function formatCompact(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(LOCALE, {
      maximumFractionDigits: 1,
    })} mi`;
  }

  if (absolute >= 1000) {
    return `${(value / 1000).toLocaleString(LOCALE, {
      maximumFractionDigits: 1,
    })} mil`;
  }

  return formatInteger(value);
}

/**
 * Percentual com uma casa, sem casa decimal quando é inteiro.
 *
 * @example
 * formatPercent(78); // "78%"
 * formatPercent(6.15); // "6,2%"
 */
export function formatPercent(value: number, digits = 0): string {
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: digits })}%`;
}

/**
 * Variação com sinal explícito, para comparações com a linha de base.
 *
 * @example
 * formatSignedPercent(18); // "+18%"
 */
export function formatSignedPercent(value: number, digits = 0): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(LOCALE, { maximumFractionDigits: digits })}%`;
}

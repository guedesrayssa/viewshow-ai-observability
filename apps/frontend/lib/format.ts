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

/* ================================ Datas e horas ================================ */

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Data e hora curtas, sempre com o dia: numa janela de 24 horas, "19:00"
 * sozinho não diz se foi hoje ou ontem.
 *
 * @example
 * formatDateTime("2026-09-29T22:00:00Z"); // "Hoje, 19:00"
 * formatDateTime("2026-09-28T22:00:00Z"); // "Ontem, 19:00"
 * formatDateTime("2026-09-20T22:00:00Z"); // "20/09, 19:00"
 */
export function formatDateTime(
  iso: string | null | undefined,
  { seconds = false, now = new Date() }: { seconds?: boolean; now?: Date } = {},
): string {
  const date = parseDate(iso);
  if (!date) return "Sem horário";

  const time = date.toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
  });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);

  if (days === 0) return `Hoje, ${time}`;
  if (days === 1) return `Ontem, ${time}`;

  const day = date.toLocaleDateString(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${day}, ${time}`;
}

/**
 * Tempo decorrido em unidade legível: minutos, horas ou dias.
 *
 * @example
 * formatElapsed(42); // "42 min"
 * formatElapsed(1321); // "22 h"
 * formatElapsed(3000); // "2 d 2 h"
 */
export function formatElapsed(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;

  const hours = Math.floor(total / 60);
  if (hours < 24) return `${hours} h`;

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

/** Minutos entre o instante informado e agora, nunca negativo. */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  const date = parseDate(iso);
  if (!date) return 0;
  return Math.max(0, Math.round((now - date.getTime()) / 60_000));
}

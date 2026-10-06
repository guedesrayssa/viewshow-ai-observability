/**
 * @file segmented-filter.tsx
 * Filtro segmentado com rótulo visível e contagem por opção.
 *
 * Usado nas listas que filtram por uma dimensão fechada (relação e força das
 * evidências, tipo de evento). Fica alinhado à esquerda, e a contagem é um
 * número à parte do nome da opção.
 */

"use client";

import { cn } from "@/lib/cn";
import { formatInteger } from "@/lib/format";

export type SegmentOption<K extends string> = {
  key: K;
  label: string;
  /** Quantos itens a opção mostraria; `null` omite a contagem. */
  total: number | string | null;
};

/**
 * Filtro segmentado com rótulo. Os segmentos são uma peça só, alinhada à
 * esquerda do cartão, e a contagem fica à parte do nome da opção.
 */
export function SegmentedFilter<K extends string>({
  label,
  groupLabel,
  value,
  options,
  onChange,
}: {
  /** Rótulo visível ao lado do controle. */
  label: string;
  /** Nome do grupo para o leitor de tela. */
  groupLabel: string;
  value: K;
  options: SegmentOption<K>[];
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-14 shrink-0 text-caption font-medium text-ink-muted">{label}</span>
      <div
        role="group"
        aria-label={groupLabel}
        className="inline-flex max-w-full overflow-x-auto rounded-field border border-line bg-surface-muted p-0.5"
      >
        {options.map((option) => {
          const active = value === option.key;

          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={active}
              // Uma opção sem itens fica desabilitada, a não ser a ativa: com a
              // outra dimensão mudada, a pessoa precisa conseguir sair dela.
              disabled={option.total === 0 && !active}
              onClick={() => onChange(option.key)}
              className={cn(
                "focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-field)-2px)] px-3 py-1.5 text-caption font-medium",
                "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                active
                  ? "bg-surface text-ink shadow-card"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {option.label}
              {option.total !== null ? (
                <span
                  className={cn(
                    "tabular-nums",
                    active ? "font-semibold text-ink-brand" : "text-ink-subtle",
                  )}
                >
                  {typeof option.total === "number" ? formatInteger(option.total) : option.total}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

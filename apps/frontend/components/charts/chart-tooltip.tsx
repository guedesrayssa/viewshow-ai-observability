/**
 * @file chart-tooltip.tsx
 * Leitura do ponto sob o cursor.
 *
 * Um gráfico de painel de plantão precisa responder "quanto foi às 09:21?" sem
 * obrigar ninguém a estimar a altura contra a grade. O balão segue o eixo
 * horizontal, se vira para o outro lado quando chega à borda e nunca cobre o
 * ponto que está sendo lido.
 */

"use client";

import { cn } from "@/lib/cn";

/** Uma linha do balão: série, cor e valor formatado. */
export type TooltipRow = {
  label: string;
  value: string;
  /** Classe de fundo do ponto da série, do design system. */
  dotClass?: string;
};

export type ChartTooltipProps = {
  /** Posição horizontal do ponto lido, em pixels do contêiner. */
  x: number;
  /** Largura do contêiner, para decidir de que lado o balão abre. */
  containerWidth: number;
  title: string;
  rows: TooltipRow[];
  /** Nota curta abaixo dos valores, como a comparação com a linha de base. */
  note?: string;
};

/** Largura estimada do balão, usada para virá-lo antes de estourar a borda. */
const WIDTH = 168;

export function ChartTooltip({
  x,
  containerWidth,
  title,
  rows,
  note,
}: ChartTooltipProps) {
  const flip = x + WIDTH + 16 > containerWidth;

  return (
    <div
      // O conteúdo já é anunciado pelo rótulo do gráfico; repeti-lo aqui faria
      // o leitor de tela ler a série inteira a cada movimento do ponteiro.
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 z-10 rounded-field border border-line",
        "bg-surface/95 p-2.5 shadow-raised backdrop-blur-sm",
      )}
      style={{
        left: x,
        width: WIDTH,
        transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
      }}
    >
      <p className="text-micro font-medium uppercase tracking-wide text-ink-subtle">
        {title}
      </p>

      <dl className="mt-1.5 flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-caption text-ink-muted">
              {row.dotClass ? (
                <span className={cn("h-1.5 w-1.5 rounded-pill", row.dotClass)} />
              ) : null}
              {row.label}
            </dt>
            <dd className="text-caption font-semibold tabular-nums text-ink">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {note ? (
        <p className="mt-1.5 border-t border-line-subtle pt-1.5 text-micro text-ink-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}

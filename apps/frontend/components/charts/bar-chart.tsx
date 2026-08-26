/**
 * @file bar-chart.tsx
 * Comparação por faixa de tempo.
 *
 * Usado onde o que interessa é comparar blocos discretos — dispositivos
 * afetados por horário, por exemplo —, e não acompanhar uma curva. Segue as
 * mesmas decisões do gráfico de série: eixo em marcas redondas, grade só na
 * horizontal e leitura por cursor.
 *
 * O valor de cada barra aparece sob demanda, no balão. Escrever todos por cima
 * do desenho transforma o gráfico em uma tabela mal formatada, e a comparação
 * de alturas — que é a razão de existir de um gráfico de barras — se perde no
 * meio dos números.
 */

"use client";

import { useMemo, useState } from "react";

import { ChartTooltip } from "@/components/charts/chart-tooltip";
import { axisTicks, labelStep, niceMax, toPlot } from "@/components/charts/scales";
import { useElementSize } from "@/hooks/use-element-size";
import { cn } from "@/lib/cn";

/** Significado da barra, sempre acompanhado de rótulo em texto na legenda. */
export type BarTone = "critical" | "warning" | "info" | "success";

const BAR_CLASSES: Record<BarTone, string> = {
  critical: "fill-critical",
  warning: "fill-brand-orange",
  info: "fill-brand-blue-light",
  success: "fill-success",
};

const DOT_CLASSES: Record<BarTone, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
  info: "bg-brand-blue-light",
  success: "bg-success",
};

export type Bar = {
  label: string;
  value: number;
  tone: BarTone;
  /** Nome do estado, exibido no balão junto do valor. */
  toneLabel: string;
};

export type BarChartProps = {
  bars: Bar[];
  formatValue: (value: number) => string;
  height?: number;
  /** Rótulo da grandeza no balão, como "dispositivos". */
  valueLabel: string;
  ariaLabel: string;
  className?: string;
};

const MARGIN = { left: 44, right: 12, top: 16, bottom: 26 };

/** Largura máxima da barra. Acima disso, o bloco vira um retângulo sem forma. */
const MAX_BAR_WIDTH = 34;

/** Passo da cascata entre barras vizinhas, em milissegundos. */
const BAR_STEP = 55;

export function BarChart({
  bars,
  formatValue,
  height = 220,
  valueLabel,
  ariaLabel,
  className,
}: BarChartProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

  const width = size.width;
  const plot = toPlot(width, height, MARGIN);

  const axisMax = useMemo(
    () => niceMax(Math.max(...bars.map((bar) => bar.value), 1)),
    [bars],
  );
  const ticks = axisTicks(axisMax);
  const step = labelStep(bars.length, plot.width, 44);

  const slot = bars.length > 0 ? plot.width / bars.length : 0;
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(6, slot * 0.55));

  const centerOf = (index: number) => plot.left + slot * (index + 0.5);
  const heightOf = (value: number) =>
    Math.max(2, (Math.min(value, axisMax) / axisMax) * plot.height);

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (slot <= 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - bounds.left - plot.left;
    const index = Math.floor(position / slot);

    setHovered(index >= 0 && index < bars.length ? index : null);
  }

  return (
    <div
      ref={ref}
      className={cn("relative", className)}
      style={{ height }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHovered(null)}
    >
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className="block"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={plot.bottom - (tick / axisMax) * plot.height}
                y2={plot.bottom - (tick / axisMax) * plot.height}
                className={tick === 0 ? "stroke-line" : "stroke-line-subtle"}
                strokeWidth={1}
              />
              <text
                x={plot.left - 8}
                y={plot.bottom - (tick / axisMax) * plot.height}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-ink-subtle text-[10px] tabular-nums"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}

          {bars.map((bar, index) => {
            const barHeight = heightOf(bar.value);
            const active = hovered === index;

            return (
              <rect
                // A chave amarrada ao valor refaz a barra a cada leitura, em vez
                // de deslizá-la para a nova altura.
                key={`${bar.label}-${bar.value}`}
                x={centerOf(index) - barWidth / 2}
                y={plot.bottom - barHeight}
                width={barWidth}
                height={barHeight}
                rx={Math.min(6, barWidth / 3)}
                className={cn(
                  BAR_CLASSES[bar.tone],
                  "bar-grow transition-[opacity] duration-200",
                  hovered !== null && !active && "opacity-45",
                )}
                style={{
                  transformOrigin: `center ${plot.bottom}px`,
                  animationDelay: `${index * BAR_STEP}ms`,
                }}
              />
            );
          })}

          {bars.map((bar, index) =>
            index % step === 0 || index === bars.length - 1 ? (
              <text
                key={bar.label}
                x={centerOf(index)}
                y={plot.bottom + 15}
                textAnchor="middle"
                className={cn(
                  "text-[10px] tabular-nums",
                  hovered === index ? "fill-ink font-medium" : "fill-ink-subtle",
                )}
              >
                {bar.label}
              </text>
            ) : null,
          )}
        </svg>
      ) : null}

      {hovered !== null && width > 0 ? (
        <ChartTooltip
          x={centerOf(hovered)}
          containerWidth={width}
          title={bars[hovered].label}
          rows={[
            {
              label: valueLabel,
              value: formatValue(bars[hovered].value),
              dotClass: DOT_CLASSES[bars[hovered].tone],
            },
          ]}
          note={bars[hovered].toneLabel}
        />
      ) : null}
    </div>
  );
}

/**
 * @file time-series-chart.tsx
 * Série temporal do painel.
 *
 * É o gráfico de linha de todas as telas: saúde da experiência, buffering,
 * volume de eventos e fluxo de processamento. Antes, cada tela desenhava o seu,
 * com margens, escalas e tamanhos de rótulo diferentes — o mesmo dado mudava de
 * aparência conforme a tela em que era lido.
 *
 * Decisões que valem para todos:
 *
 * - **Desenho em pixels reais.** O contêiner é medido e o SVG usa as
 *   coordenadas dele. Um `viewBox` esticado por `preserveAspectRatio="none"`
 *   serve a qualquer largura, mas distorce os rótulos e a espessura do traço.
 * - **Eixo em marcas redondas.** O teto vem de `niceMax`, então a altura da
 *   linha já diz a ordem de grandeza sem ler o número.
 * - **Grade só na horizontal.** A vertical competiria com o traço da série.
 * - **Leitura por cursor.** Passar o ponteiro mostra a linha guia, marca o
 *   ponto em cada série e abre o valor exato — em vez de espalhar rótulos por
 *   cima da curva.
 * - **Anotação em vez de enfeite.** O pico ganha um ponto e um rótulo discreto;
 *   marcos como um deploy entram como linha tracejada com nome.
 */

"use client";

import { useMemo, useState } from "react";

import { ChartTooltip, type TooltipRow } from "@/components/charts/chart-tooltip";
import {
  axisTicks,
  labelStep,
  niceMax,
  toAreaPath,
  toLinePath,
  toPlot,
} from "@/components/charts/scales";
import { useElementSize } from "@/hooks/use-element-size";
import { cn } from "@/lib/cn";

/** Cor da série, sempre do design system. */
export type SeriesTone = "critical" | "warning" | "info" | "brand" | "muted";

const STROKE_CLASSES: Record<SeriesTone, string> = {
  critical: "stroke-critical",
  warning: "stroke-brand-orange",
  info: "stroke-brand-blue-light",
  brand: "stroke-brand-orange",
  muted: "stroke-ink-subtle",
};

const FILL_CLASSES: Record<SeriesTone, string> = {
  critical: "fill-critical",
  warning: "fill-brand-orange",
  info: "fill-brand-blue-light",
  brand: "fill-brand-orange",
  muted: "fill-ink-subtle",
};

const DOT_CLASSES: Record<SeriesTone, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
  info: "bg-brand-blue-light",
  brand: "bg-brand-orange",
  muted: "bg-ink-subtle",
};

export type ChartSeries = {
  id: string;
  label: string;
  values: number[];
  tone: SeriesTone;
  /** Preenche a área sob a linha. Reserve para a série principal. */
  area?: boolean;
  /** Traço tracejado, para séries de comparação. */
  dashed?: boolean;
};

/** Linha horizontal de referência, como a meta operacional. */
export type ChartReference = {
  value: number;
  label: string;
};

/** Marco vertical, como o horário de um deploy. */
export type ChartMarker = {
  index: number;
  label: string;
};

export type TimeSeriesChartProps = {
  /** Rótulos do eixo horizontal, um por ponto. */
  labels: string[];
  series: ChartSeries[];
  /** Escreve o valor no eixo e no balão. */
  formatValue: (value: number) => string;
  /** Altura do desenho, em pixels. */
  height?: number;
  /** Teto do eixo. Sem ele, o teto sai do maior valor das séries. */
  max?: number;
  reference?: ChartReference;
  marker?: ChartMarker;
  /** Faixa destacada no fundo, por índice inicial e final. */
  highlight?: [number, number];
  /** Marca o maior valor da primeira série. */
  showPeak?: boolean;
  /** Nota exibida no balão, abaixo dos valores. */
  tooltipNote?: (index: number) => string | undefined;
  ariaLabel: string;
  className?: string;
};

const MARGIN = { left: 44, right: 12, top: 24, bottom: 26 };

/** Duração do traço, casada com `--animate-draw`. */
const DRAW_MS = 1150;

export function TimeSeriesChart({
  labels,
  series,
  formatValue,
  height = 220,
  max,
  reference,
  marker,
  highlight,
  showPeak = false,
  tooltipNote,
  ariaLabel,
  className,
}: TimeSeriesChartProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

  const width = size.width;
  const plot = toPlot(width, height, MARGIN);

  const axisMax = useMemo(() => {
    if (max !== undefined) return max;

    const highest = Math.max(
      ...series.flatMap((item) => item.values),
      reference?.value ?? 0,
    );
    return niceMax(highest);
  }, [max, series, reference]);

  const ticks = axisTicks(axisMax);
  const step = labelStep(labels.length, plot.width);

  const xFor = (index: number) =>
    labels.length <= 1
      ? plot.left
      : plot.left + (index / (labels.length - 1)) * plot.width;
  const yFor = (value: number) =>
    plot.bottom - Math.min(1, Math.max(0, value / axisMax)) * plot.height;

  const projected = series.map((item) => ({
    ...item,
    points: item.values.map((value, index) => ({ x: xFor(index), y: yFor(value) })),
  }));

  const peakIndex = showPeak
    ? series[0]?.values.reduce(
        (best, value, index, all) => (value > all[best] ? index : best),
        0,
      )
    : undefined;

  /** Índice do ponto mais próximo do cursor. */
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (plot.width <= 0 || labels.length === 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - bounds.left - plot.left;
    const ratio = position / plot.width;
    const index = Math.round(ratio * (labels.length - 1));

    setHovered(Math.min(labels.length - 1, Math.max(0, index)));
  }

  const rows: TooltipRow[] =
    hovered === null
      ? []
      : series.map((item) => ({
          label: item.label,
          value: formatValue(item.values[hovered] ?? 0),
          dotClass: DOT_CLASSES[item.tone],
        }));

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
          {highlight ? (
            <rect
              x={xFor(highlight[0])}
              y={plot.top}
              width={Math.max(0, xFor(highlight[1]) - xFor(highlight[0]))}
              height={plot.height}
              className="animate-fade-in fill-warning/10"
              style={{ animationDelay: `${DRAW_MS * 0.4}ms` }}
            />
          ) : null}

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={yFor(tick)}
                y2={yFor(tick)}
                className={tick === 0 ? "stroke-line" : "stroke-line-subtle"}
                strokeWidth={1}
              />
              <text
                x={plot.left - 8}
                y={yFor(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-ink-subtle text-[10px] tabular-nums"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}

          {reference ? (
            <g>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={yFor(reference.value)}
                y2={yFor(reference.value)}
                className="stroke-warning"
                strokeWidth={1}
                strokeDasharray="5 4"
              />
              <text
                x={plot.right}
                y={yFor(reference.value) - 5}
                textAnchor="end"
                className="fill-warning-strong text-[10px]"
              >
                {reference.label}
              </text>
            </g>
          ) : null}

          {marker && labels[marker.index] ? (
            <g className="animate-fade-in">
              <line
                x1={xFor(marker.index)}
                x2={xFor(marker.index)}
                y1={plot.top}
                y2={plot.bottom}
                className="stroke-ink-brand"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={xFor(marker.index)}
                y={plot.top - 8}
                textAnchor="middle"
                className="fill-ink-brand text-[10px] font-medium"
              >
                {marker.label}
              </text>
            </g>
          ) : null}

          {projected.map((item, order) =>
            item.area ? (
              <path
                key={`${item.id}-area`}
                d={toAreaPath(item.points, plot.bottom)}
                className={cn("animate-fade-in", FILL_CLASSES[item.tone])}
                fillOpacity={0.12}
                style={{ animationDelay: `${DRAW_MS * 0.35 + order * 80}ms` }}
              />
            ) : null,
          )}

          {projected.map((item, order) => (
            <path
              // `pathLength={1}` normaliza o traço: o mesmo par
              // dasharray/dashoffset serve a qualquer série.
              key={item.id}
              d={toLinePath(item.points)}
              fill="none"
              pathLength={1}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={item.dashed ? "5 4" : undefined}
              className={cn(
                STROKE_CLASSES[item.tone],
                !item.dashed && "animate-draw",
              )}
              style={
                item.dashed
                  ? undefined
                  : {
                      strokeDasharray: 1,
                      strokeDashoffset: 1,
                      animationDelay: `${order * 140}ms`,
                    }
              }
            />
          ))}

          {typeof peakIndex === "number" && projected[0]?.points[peakIndex] ? (
            <g
              className="animate-pop"
              style={{
                animationDelay: `${DRAW_MS * 0.85}ms`,
                transformOrigin: `${projected[0].points[peakIndex].x}px ${projected[0].points[peakIndex].y}px`,
              }}
            >
              <circle
                cx={projected[0].points[peakIndex].x}
                cy={projected[0].points[peakIndex].y}
                r={3.5}
                className={cn(FILL_CLASSES[projected[0].tone], "stroke-surface")}
                strokeWidth={2}
              />
              <text
                x={projected[0].points[peakIndex].x}
                y={projected[0].points[peakIndex].y - 10}
                textAnchor={
                  peakIndex > labels.length - 2
                    ? "end"
                    : peakIndex === 0
                      ? "start"
                      : "middle"
                }
                className="fill-ink text-[11px] font-semibold tabular-nums"
              >
                {formatValue(series[0].values[peakIndex])}
              </text>
            </g>
          ) : null}

          {hovered !== null ? (
            <g>
              <line
                x1={xFor(hovered)}
                x2={xFor(hovered)}
                y1={plot.top}
                y2={plot.bottom}
                className="stroke-line-strong"
                strokeWidth={1}
              />
              {projected.map((item) => (
                <circle
                  key={`${item.id}-hover`}
                  cx={item.points[hovered]?.x}
                  cy={item.points[hovered]?.y}
                  r={3.5}
                  className={cn(FILL_CLASSES[item.tone], "stroke-surface")}
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}

          {labels.map((label, index) =>
            index % step === 0 || index === labels.length - 1 ? (
              <text
                key={label + index}
                x={xFor(index)}
                y={plot.bottom + 15}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === labels.length - 1
                      ? "end"
                      : "middle"
                }
                className={cn(
                  "text-[10px] tabular-nums",
                  hovered === index ? "fill-ink font-medium" : "fill-ink-subtle",
                )}
              >
                {label}
              </text>
            ) : null,
          )}
        </svg>
      ) : null}

      {hovered !== null && width > 0 ? (
        <ChartTooltip
          x={xFor(hovered)}
          containerWidth={width}
          title={labels[hovered]}
          rows={rows}
          note={tooltipNote?.(hovered)}
        />
      ) : null}
    </div>
  );
}

/** Legenda das séries, para usar acima ou abaixo do gráfico. */
export function ChartLegend({
  items,
  className,
}: {
  items: { label: string; tone: SeriesTone; dashed?: boolean }[];
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-4", className)}>
      {items.map((item) => (
        <li
          key={item.label}
          className="flex items-center gap-1.5 text-caption text-ink-muted"
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-0.5 w-4 rounded-pill",
              DOT_CLASSES[item.tone],
              item.dashed && "opacity-60",
            )}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

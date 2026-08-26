/**
 * @file line-chart.tsx
 * Série temporal do painel.
 *
 * A linha é desenhada da esquerda para a direita quando o gráfico aparece, e
 * de novo a cada leitura: o traço acompanha a passagem do tempo que o eixo
 * representa, então ver a série ser escrita ajuda a ler onde ela virou. O
 * marcador do pico entra depois do traço, quando já existe contexto para ele.
 *
 * O desenho é SVG puro. O projeto não tem biblioteca de gráficos, e a série é
 * simples o bastante para não justificar uma.
 */

"use client";

import type { ExperiencePoint } from "@/lib/dashboard-data";

type LineChartProps = {
  id?: string;
  data: ExperiencePoint[];
  max: number;
  yTicks: number[];
  baseline?: number;
  highlightRange?: [number, number];
  peakIndex?: number;
  peakLabel?: string;
  xTickEvery?: number;
  /** Rótulo do gráfico para leitores de tela. */
  ariaLabel?: string;
};

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 320;
const PADDING_LEFT = 56;
const PADDING_RIGHT = 28;
const PADDING_TOP = 36;
const PADDING_BOTTOM = 28;

const PLOT_X0 = PADDING_LEFT;
const PLOT_X1 = VIEW_WIDTH - PADDING_RIGHT;
const PLOT_Y0 = PADDING_TOP;
const PLOT_Y1 = VIEW_HEIGHT - PADDING_BOTTOM;

/** Duração do traço, casada com `--animate-draw`. */
const DRAW_MS = 1150;

export function getPointXPercent(index: number, totalPoints: number) {
  const x = PLOT_X0 + (index / (totalPoints - 1)) * (PLOT_X1 - PLOT_X0);
  return (x / VIEW_WIDTH) * 100;
}

export function LineChart({
  id = "line-chart",
  data,
  max,
  yTicks,
  baseline,
  highlightRange,
  peakIndex,
  peakLabel,
  xTickEvery = 1,
  ariaLabel = "Gráfico de série temporal da saúde da experiência",
}: LineChartProps) {
  const xForIndex = (index: number) =>
    PLOT_X0 + (index / (data.length - 1)) * (PLOT_X1 - PLOT_X0);
  const yForValue = (value: number) =>
    PLOT_Y1 - (value / max) * (PLOT_Y1 - PLOT_Y0);

  const linePoints = data.map((point, index) => [
    xForIndex(index),
    yForValue(point.value),
  ]);

  const linePath = linePoints
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");

  const areaPath = `${linePath} L${PLOT_X1},${PLOT_Y1} L${PLOT_X0},${PLOT_Y1} Z`;

  const gradientId = `${id}-area`;

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-info)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--color-info)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {highlightRange && (
        <rect
          x={xForIndex(highlightRange[0])}
          y={PLOT_Y0}
          width={xForIndex(highlightRange[1]) - xForIndex(highlightRange[0])}
          height={PLOT_Y1 - PLOT_Y0}
          fill="var(--color-warning)"
          fillOpacity={0.12}
          className="animate-fade-in"
          style={{ animationDelay: `${DRAW_MS * 0.4}ms` }}
        />
      )}

      {yTicks.map((tick) => (
        <g key={tick}>
          {tick === baseline ? (
            <line
              x1={PLOT_X0}
              x2={PLOT_X1}
              y1={yForValue(tick)}
              y2={yForValue(tick)}
              stroke="var(--color-ink-muted)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          <text
            x={PLOT_X0 - 10}
            y={yForValue(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-ink-muted text-[11px]"
          >
            {tick === 0 ? "0" : `${tick}/min`}
          </text>
        </g>
      ))}

      <path
        d={areaPath}
        fill={`url(#${gradientId})`}
        className="animate-fade-in"
        style={{ animationDelay: `${DRAW_MS * 0.35}ms`, animationDuration: "700ms" }}
      />

      {/* `pathLength={1}` normaliza o comprimento do traço: o mesmo par
          dasharray/dashoffset serve a qualquer série, sem medir o path. */}
      <path
        d={linePath}
        fill="none"
        stroke="var(--color-info)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className="animate-draw"
        style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
      />

      {data.map((point, index) => {
        if (index % xTickEvery !== 0) return null;
        return (
          <text
            key={point.label}
            x={xForIndex(index)}
            y={VIEW_HEIGHT - 6}
            textAnchor="middle"
            className="fill-ink-muted text-[11px]"
          >
            {point.label}
          </text>
        );
      })}

      {typeof peakIndex === "number" && data[peakIndex] && (
        <g
          className="animate-pop"
          style={{
            animationDelay: `${DRAW_MS * 0.85}ms`,
            transformOrigin: `${xForIndex(peakIndex)}px ${yForValue(data[peakIndex].value)}px`,
          }}
        >
          <circle
            cx={xForIndex(peakIndex)}
            cy={yForValue(data[peakIndex].value)}
            r={5}
            fill="var(--color-critical)"
            stroke="var(--color-surface)"
            strokeWidth={2}
          />
          {peakLabel && (
            <g
              transform={`translate(${xForIndex(peakIndex)}, ${yForValue(data[peakIndex].value) - 34})`}
            >
              <rect
                x={-34}
                y={-11}
                width={68}
                height={22}
                rx={11}
                fill="var(--color-critical)"
              />
              <text
                x={0}
                y={0}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-ink-inverse text-[11px] font-semibold"
              >
                {peakLabel}
              </text>
            </g>
          )}
        </g>
      )}
    </svg>
  );
}

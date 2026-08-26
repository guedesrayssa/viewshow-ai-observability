/**
 * @file buffering-chart.tsx
 * Gráfico "Buffering após a versão 4.2.1".
 *
 * É a evidência quantitativa da hipótese: mostra o salto do buffer ratio logo
 * depois do deploy destacado. O traço é escrito da esquerda para a direita, e o
 * marcador do pico só aparece quando a linha chega nele — a ordem do movimento
 * é a ordem do argumento: primeiro o deploy, depois a subida.
 */

"use client";

import {
  BUFFERING_PERIOD_LABELS,
  DEPLOY_INDEX,
  DEPLOY_LABEL,
  type BufferingPeriodKey,
  type BufferingPoint,
} from "@/app/(painel)/evidencias/evidence-data";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDecimal } from "@/lib/format";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 200;
const PADDING_LEFT = 28;
const PADDING_RIGHT = 12;
const PADDING_TOP = 36;
const PADDING_BOTTOM = 24;

const PLOT_X0 = PADDING_LEFT;
const PLOT_X1 = VIEW_WIDTH - PADDING_RIGHT;
const PLOT_Y0 = PADDING_TOP;
const PLOT_Y1 = VIEW_HEIGHT - PADDING_BOTTOM;

const Y_MAX = 6;
const Y_TICKS = [0, 3, 6];

/** Duração do traço, casada com `--animate-draw`. */
const DRAW_MS = 1150;

export type BufferingChartProps = {
  points?: BufferingPoint[];
  period: BufferingPeriodKey;
  onPeriodChange: (period: BufferingPeriodKey) => void;
};

export function BufferingChart({
  points,
  period,
  onPeriodChange,
}: BufferingChartProps) {
  return (
    <Card accent="brand" accentPosition="top" padding="lg" className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Buffering após a versão 4.2.1</CardTitle>
          <CardDescription className="mt-1">
            Youbora · buffer ratio (%) · LG webOS 6.0
          </CardDescription>
        </div>

        <Select
          aria-label="Período do gráfico de buffering"
          value={period}
          onValueChange={(value) => onPeriodChange(value as BufferingPeriodKey)}
          options={(
            Object.keys(BUFFERING_PERIOD_LABELS) as BufferingPeriodKey[]
          ).map((key) => ({ value: key, label: BUFFERING_PERIOD_LABELS[key] }))}
        />
      </div>

      {!points || points.length === 0 ? (
        <>
          <Skeleton className="mt-4 h-44 w-full" />
          <Skeleton className="mt-2 h-3 w-56" />
        </>
      ) : (
        <BufferingPlot points={points} period={period} />
      )}
    </Card>
  );
}

function BufferingPlot({
  points,
  period,
}: {
  points: BufferingPoint[];
  period: BufferingPeriodKey;
}) {
  const deployIndex = Math.min(DEPLOY_INDEX[period], points.length - 1);

  const peakIndex = points.reduce(
    (best, point, index) => (point.value > points[best].value ? index : best),
    0,
  );
  const peak = points[peakIndex];
  const baseline = points[0].value;
  const multiplier = formatDecimal(peak.value / baseline, 1);

  const xForIndex = (index: number) =>
    PLOT_X0 + (index / (points.length - 1)) * (PLOT_X1 - PLOT_X0);
  const yForValue = (value: number) =>
    PLOT_Y1 - (value / Y_MAX) * (PLOT_Y1 - PLOT_Y0);

  const linePath = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${xForIndex(index)},${yForValue(point.value)}`,
    )
    .join(" ");
  const areaPath = `${linePath} L${xForIndex(points.length - 1)},${PLOT_Y1} L${PLOT_X0},${PLOT_Y1} Z`;

  return (
    <>
      <div className="relative mt-4 h-44">
        <svg
          // A chave amarrada à série redesenha o traço a cada nova leitura.
          key={points.map((point) => point.value).join(",")}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Buffer ratio ao longo do tempo, com pico de ${formatDecimal(peak.value, 1)}% às ${peak.time}`}
        >
          <defs>
            <linearGradient id="buffering-area" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-brand-orange)"
                stopOpacity={0.22}
              />
              <stop
                offset="100%"
                stopColor="var(--color-brand-orange)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>

          {Y_TICKS.map((tick) => (
            <g key={tick}>
              <line
                x1={PLOT_X0}
                x2={PLOT_X1}
                y1={yForValue(tick)}
                y2={yForValue(tick)}
                stroke="var(--color-line-subtle)"
                strokeWidth={1}
              />
              <text
                x={PLOT_X0 - 8}
                y={yForValue(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-ink-subtle text-[10px]"
              >
                {tick === 0 ? "0" : `${tick}%`}
              </text>
            </g>
          ))}

          {/* O marco do deploy entra antes da linha: é ele que o gráfico está
              tentando relacionar com a subida. */}
          <g className="animate-fade-in">
            <line
              x1={xForIndex(deployIndex)}
              x2={xForIndex(deployIndex)}
              y1={PLOT_Y0}
              y2={PLOT_Y1}
              stroke="var(--color-ink-brand)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
            <text
              x={xForIndex(deployIndex)}
              y={PLOT_Y0 - 10}
              textAnchor="middle"
              className="fill-ink-brand text-[10px] font-medium"
            >
              {DEPLOY_LABEL}
            </text>
          </g>

          <path
            d={areaPath}
            fill="url(#buffering-area)"
            className="animate-fade-in"
            style={{ animationDelay: `${DRAW_MS * 0.35}ms` }}
          />

          <path
            d={linePath}
            fill="none"
            stroke="var(--color-brand-orange)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            className="animate-draw"
            style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
          />

          <g
            className="animate-pop"
            style={{
              animationDelay: `${DRAW_MS * 0.85}ms`,
              transformOrigin: `${xForIndex(peakIndex)}px ${yForValue(peak.value)}px`,
            }}
          >
            <circle
              cx={xForIndex(peakIndex)}
              cy={yForValue(peak.value)}
              r={4.5}
              fill="var(--color-critical)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
            <text
              x={xForIndex(peakIndex)}
              y={yForValue(peak.value) - 12}
              textAnchor="middle"
              className="fill-critical-strong text-[11px] font-semibold"
            >
              {formatDecimal(peak.value, 1)}%
            </text>
          </g>

          {points.map((point, index) => (
            <text
              key={point.time}
              x={xForIndex(index)}
              y={VIEW_HEIGHT - 4}
              textAnchor="middle"
              className="fill-ink-subtle text-[10px]"
            >
              {point.time}
            </text>
          ))}
        </svg>
      </div>

      <p className="mt-2 text-caption font-medium text-critical-strong">
        +{multiplier}x vs. linha de base · forte evidência
      </p>
    </>
  );
}

/**
 * @file events-chart.tsx
 * Gráfico "Volume temporal dos eventos".
 *
 * Mostra a curva de eventos por minuto da camada normalizada, com o pico e a
 * janela anômala em destaque. O traço é escrito da esquerda para a direita a
 * cada leitura, como nos demais gráficos do painel: o eixo é o tempo, e ver a
 * linha avançar é ler o tempo passar.
 */

"use client";

import {
  formatVolume,
  formatVolumePerMinute,
  VOLUME_PERIOD_LABELS,
  type VolumePeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/eventos/events-data";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

const LEGEND = [
  { label: "Eventos normais", dotClass: "bg-brand-blue-light" },
  { label: "Erros", dotClass: "bg-critical" },
  { label: "Telemetria atrasada/duplicada", dotClass: "bg-warning" },
];

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 240;
const PADDING_LEFT = 40;
const PADDING_RIGHT = 12;
const PADDING_TOP = 36;
const PADDING_BOTTOM = 40;

const PLOT_X0 = PADDING_LEFT;
const PLOT_X1 = VIEW_WIDTH - PADDING_RIGHT;
const PLOT_Y0 = PADDING_TOP;
const PLOT_Y1 = VIEW_HEIGHT - PADDING_BOTTOM;

/** Duração do traço, casada com `--animate-draw`. */
const DRAW_MS = 1150;

export type EventsChartProps = {
  series?: VolumeSeries;
  period: VolumePeriodKey;
  onPeriodChange: (period: VolumePeriodKey) => void;
};

export function EventsChart({ series, period, onPeriodChange }: EventsChartProps) {
  return (
    <Card accent="brand" accentPosition="top" padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Volume temporal dos eventos</CardTitle>
          <CardDescription className="mt-1">
            Camada normalizada signal_point · eventos por minuto
          </CardDescription>
        </div>

        <Select
          aria-label="Período do gráfico de volume"
          value={period}
          onValueChange={(value) => onPeriodChange(value as VolumePeriodKey)}
          options={(Object.keys(VOLUME_PERIOD_LABELS) as VolumePeriodKey[]).map(
            (key) => ({ value: key, label: VOLUME_PERIOD_LABELS[key] }),
          )}
        />
      </div>

      {!series ? (
        <Skeleton className="mt-6 h-60 w-full" />
      ) : (
        <VolumePlot series={series} />
      )}

      <ul className="mt-2 flex flex-wrap items-center gap-5">
        {LEGEND.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-1.5 text-caption text-ink-muted"
          >
            <span
              aria-hidden="true"
              className={cn("h-2.5 w-2.5 rounded-pill", item.dotClass)}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function VolumePlot({ series }: { series: VolumeSeries }) {
  const { times, values, peakIndex, anomalyRange, axisMax, axisTicks } = series;
  const [anomalyStart, anomalyEnd] = anomalyRange;
  const peak = values[peakIndex];

  const xForIndex = (index: number) =>
    PLOT_X0 + (index / (times.length - 1)) * (PLOT_X1 - PLOT_X0);
  const yForValue = (value: number) =>
    PLOT_Y1 - Math.min(1, value / axisMax) * (PLOT_Y1 - PLOT_Y0);

  const linePath = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${xForIndex(index)},${yForValue(value)}`,
    )
    .join(" ");
  const areaPath = `${linePath} L${xForIndex(values.length - 1)},${PLOT_Y1} L${PLOT_X0},${PLOT_Y1} Z`;

  const anomalyX0 = xForIndex(anomalyStart);
  const anomalyX1 = xForIndex(anomalyEnd);

  return (
    <div className="relative mt-6 h-60">
      <svg
        key={values.join(",")}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={`Volume de eventos por minuto. Parte de ${formatVolume(
          values[0],
        )}, atinge o pico de ${formatVolumePerMinute(peak)} às ${
          times[peakIndex]
        } e termina em ${formatVolume(values[values.length - 1])}. Janela anômala entre ${
          times[anomalyStart]
        } e ${times[anomalyEnd]}.`}
      >
        <defs>
          <linearGradient id="events-volume-area" x1="0" y1="0" x2="0" y2="1">
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

        {axisTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PLOT_X0}
              x2={PLOT_X1}
              y1={yForValue(tick)}
              y2={yForValue(tick)}
              stroke="var(--color-line-subtle)"
              strokeWidth={1}
              strokeDasharray={tick === 0 ? "4 4" : undefined}
            />
            <text
              x={PLOT_X0 - 8}
              y={yForValue(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-ink-subtle text-[10px]"
            >
              {tick === 0 ? "0" : formatVolume(tick)}
            </text>
          </g>
        ))}

        <rect
          x={anomalyX0}
          y={PLOT_Y0}
          width={anomalyX1 - anomalyX0}
          height={PLOT_Y1 - PLOT_Y0}
          className="animate-fade-in fill-brand-orange/10"
          style={{ animationDelay: `${DRAW_MS * 0.4}ms` }}
        />

        <path
          d={areaPath}
          fill="url(#events-volume-area)"
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
            transformOrigin: `${xForIndex(peakIndex)}px ${yForValue(peak)}px`,
          }}
        >
          <circle
            cx={xForIndex(peakIndex)}
            cy={yForValue(peak)}
            r={4.5}
            fill="var(--color-critical)"
            stroke="var(--color-surface)"
            strokeWidth={2}
          />
          <text
            x={xForIndex(peakIndex)}
            y={yForValue(peak) - 12}
            textAnchor="middle"
            className="fill-critical-strong text-[11px] font-semibold"
          >
            {formatVolumePerMinute(peak)}
          </text>
        </g>

        <text
          x={(anomalyX0 + anomalyX1) / 2}
          y={PLOT_Y1 + 16}
          textAnchor="middle"
          className="fill-critical-strong text-[10px] font-medium"
        >
          janela anômala
        </text>

        {times.map((time, index) => (
          <text
            key={time}
            x={xForIndex(index)}
            y={VIEW_HEIGHT - 6}
            textAnchor="middle"
            className={cn(
              "text-[10px]",
              index === peakIndex
                ? "fill-critical-strong font-medium"
                : "fill-ink-brand",
            )}
          >
            {time}
          </text>
        ))}
      </svg>
    </div>
  );
}

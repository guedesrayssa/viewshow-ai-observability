/**
 * @file events-chart.tsx
 * Gráfico "Volume temporal dos eventos".
 *
 * Mostra a curva de eventos por minuto da camada normalizada, com o pico e a
 * janela anômala em destaque, no mesmo espírito do gráfico de buffering da
 * tela de Evidências: SVG com `viewBox` fixo, sem biblioteca externa de
 * gráficos (o projeto não tem uma instalada).
 */

"use client";

import { useState } from "react";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

import {
  formatVolume,
  formatVolumePerMinute,
  VOLUME_ANOMALY_RANGE,
  VOLUME_AXIS_MAX,
  VOLUME_AXIS_TICKS,
  VOLUME_PEAK_INDEX,
  VOLUME_TIMES,
  VOLUME_VALUES,
} from "@/app/(painel)/eventos/events-data";

type PeriodKey = "30" | "60" | "180";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Período: últimos 30 min",
  "60": "Período: última hora",
  "180": "Período: últimas 3 horas",
};

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

export function EventsChart() {
  const [period, setPeriod] = useState<PeriodKey>("30");

  const times = VOLUME_TIMES;
  const values = VOLUME_VALUES;
  const [anomalyStart, anomalyEnd] = VOLUME_ANOMALY_RANGE;
  const peak = values[VOLUME_PEAK_INDEX];

  const xForIndex = (index: number) =>
    PLOT_X0 + (index / (times.length - 1)) * (PLOT_X1 - PLOT_X0);
  const yForValue = (value: number) =>
    PLOT_Y1 - (Math.min(1, value / VOLUME_AXIS_MAX)) * (PLOT_Y1 - PLOT_Y0);

  const linePath = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${xForIndex(index)},${yForValue(value)}`)
    .join(" ");
  const areaPath = `${linePath} L${xForIndex(values.length - 1)},${PLOT_Y1} L${PLOT_X0},${PLOT_Y1} Z`;

  const anomalyX0 = xForIndex(anomalyStart);
  const anomalyX1 = xForIndex(anomalyEnd);

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
          onChange={(event) => setPeriod(event.target.value as PeriodKey)}
        >
          {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => (
            <option key={key} value={key}>
              {PERIOD_LABELS[key]}
            </option>
          ))}
        </Select>
      </div>

      <div className="relative mt-6 h-60">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Volume de eventos por minuto. Parte de ${formatVolume(
            values[0],
          )}, atinge o pico de ${formatVolumePerMinute(peak)} às ${
            times[VOLUME_PEAK_INDEX]
          } e termina em ${formatVolume(values[values.length - 1])}. Janela anômala entre ${
            times[anomalyStart]
          } e ${times[anomalyEnd]}.`}
        >
          <defs>
            <linearGradient id="events-volume-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand-orange)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--color-brand-orange)" stopOpacity={0} />
            </linearGradient>
          </defs>

          {VOLUME_AXIS_TICKS.map((tick) => (
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
            className="fill-brand-orange/10"
          />

          <path d={areaPath} fill="url(#events-volume-area)" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-brand-orange)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <circle
            cx={xForIndex(VOLUME_PEAK_INDEX)}
            cy={yForValue(peak)}
            r={4.5}
            fill="var(--color-critical)"
            stroke="var(--color-surface)"
            strokeWidth={2}
          />
          <text
            x={xForIndex(VOLUME_PEAK_INDEX)}
            y={yForValue(peak) - 12}
            textAnchor="middle"
            className="fill-critical-strong text-[11px] font-semibold"
          >
            {formatVolumePerMinute(peak)}
          </text>

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
                index === VOLUME_PEAK_INDEX ? "fill-critical-strong font-medium" : "fill-brand-blue",
              )}
            >
              {time}
            </text>
          ))}
        </svg>
      </div>

      <ul className="mt-2 flex flex-wrap items-center gap-5">
        {LEGEND.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-1.5 text-caption text-ink-muted"
          >
            <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-pill", item.dotClass)} />
            {item.label}
          </li>
        ))}
      </ul>
    </Card>
  );
}

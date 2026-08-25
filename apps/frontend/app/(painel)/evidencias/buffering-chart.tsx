/**
 * @file buffering-chart.tsx
 * Gráfico "Buffering após a versão 4.2.1".
 *
 * Evidência quantitativa da hipótese: mostra o salto do buffer ratio logo
 * após o deploy destacado, sem depender de biblioteca externa de gráficos
 * (o projeto não tem uma instalada), no mesmo espírito do gráfico de
 * incidentes por horário.
 */

"use client";

import { useState } from "react";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

type BufferingPoint = {
  time: string;
  value: number;
};

type PeriodKey = "60" | "120" | "360";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  "60": "Última hora",
  "120": "Últimas 2 horas",
  "360": "Últimas 6 horas",
};

/** Série de exemplo, com o mesmo salto do protótipo de alta fidelidade. */
const PERIOD_DATASETS: Record<PeriodKey, BufferingPoint[]> = {
  "60": [
    { time: "09:10", value: 1.6 },
    { time: "09:20", value: 1.9 },
    { time: "09:30", value: 2.6 },
    { time: "09:40", value: 3.9 },
    { time: "09:50", value: 4.9 },
    { time: "10:00", value: 4.2 },
  ],
  "120": [
    { time: "08:30", value: 0.8 },
    { time: "08:50", value: 1.0 },
    { time: "09:10", value: 1.6 },
    { time: "09:30", value: 2.6 },
    { time: "09:50", value: 4.9 },
    { time: "10:10", value: 3.8 },
  ],
  "360": [
    { time: "05:10", value: 0.6 },
    { time: "06:10", value: 0.7 },
    { time: "07:10", value: 0.9 },
    { time: "08:10", value: 1.1 },
    { time: "09:10", value: 1.6 },
    { time: "09:50", value: 4.9 },
    { time: "10:50", value: 3.1 },
  ],
};

/** Índice do ponto de deploy em cada janela, para a linha tracejada e o rótulo. */
const DEPLOY_INDEX: Record<PeriodKey, number> = { "60": 2, "120": 3, "360": 5 };
const DEPLOY_LABEL = "Deploy 4.2.1";

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

export function BufferingChart() {
  const [period, setPeriod] = useState<PeriodKey>("120");
  const points = PERIOD_DATASETS[period];
  const deployIndex = DEPLOY_INDEX[period];

  const peakIndex = points.reduce(
    (best, point, index) => (point.value > points[best].value ? index : best),
    0,
  );
  const peak = points[peakIndex];
  const baseline = points[0].value;
  const multiplier = (peak.value / baseline).toLocaleString("pt-BR", {
    maximumFractionDigits: 1,
  });

  const xForIndex = (index: number) =>
    PLOT_X0 + (index / (points.length - 1)) * (PLOT_X1 - PLOT_X0);
  const yForValue = (value: number) =>
    PLOT_Y1 - (value / Y_MAX) * (PLOT_Y1 - PLOT_Y0);

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xForIndex(index)},${yForValue(point.value)}`)
    .join(" ");
  const areaPath = `${linePath} L${xForIndex(points.length - 1)},${PLOT_Y1} L${PLOT_X0},${PLOT_Y1} Z`;

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
          fieldSize="sm"
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

      <div className="relative mt-4 h-44">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Buffer ratio ao longo do tempo, com pico de ${peak.value}% às ${peak.time}`}
        >
          <defs>
            <linearGradient id="buffering-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand-orange)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--color-brand-orange)" stopOpacity={0} />
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

          <line
            x1={xForIndex(deployIndex)}
            x2={xForIndex(deployIndex)}
            y1={PLOT_Y0}
            y2={PLOT_Y1}
            stroke="var(--color-brand-blue)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
          />
          <text
            x={xForIndex(deployIndex)}
            y={PLOT_Y0 - 10}
            textAnchor="middle"
            className="fill-brand-blue text-[10px] font-medium"
          >
            {DEPLOY_LABEL}
          </text>

          <path d={areaPath} fill="url(#buffering-area)" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-brand-orange)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

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
            {peak.value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
          </text>

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
    </Card>
  );
}

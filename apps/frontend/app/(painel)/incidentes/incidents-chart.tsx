/**
 * @file incidents-chart.tsx
 * Gráfico "Dispositivos afetados por horário".
 *
 * Cobre a funcionalidade descrita na seção 5.3 do entendimento de UX: mostra
 * a evolução de dispositivos impactados e diferencia visualmente incidentes
 * críticos dos de alta severidade, sem depender de biblioteca externa de
 * gráficos (o projeto não tem uma instalada).
 */

"use client";

import { useState } from "react";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

type ChartLevel = "critical" | "warning";

type ChartBucket = {
  time: string;
  value: number;
  level: ChartLevel;
};

type PeriodKey = "60" | "360" | "1440";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

/** Séries de exemplo por janela de tempo, enquanto a integração com a telemetria não existe. */
const PERIOD_DATASETS: Record<PeriodKey, ChartBucket[]> = {
  "60": [
    { time: "09:00", value: 3100, level: "warning" },
    { time: "09:10", value: 5600, level: "warning" },
    { time: "09:20", value: 4700, level: "warning" },
    { time: "09:30", value: 7200, level: "warning" },
    { time: "09:40", value: 9800, level: "critical" },
    { time: "09:50", value: 12400, level: "critical" },
    { time: "10:00", value: 10100, level: "critical" },
    { time: "10:10", value: 8500, level: "warning" },
  ],
  "360": [
    { time: "05:00", value: 4200, level: "warning" },
    { time: "06:00", value: 6800, level: "warning" },
    { time: "07:00", value: 5100, level: "warning" },
    { time: "08:00", value: 11300, level: "critical" },
    { time: "09:00", value: 18700, level: "critical" },
    { time: "10:00", value: 10100, level: "warning" },
  ],
  "1440": [
    { time: "00h", value: 2600, level: "warning" },
    { time: "03h", value: 1900, level: "warning" },
    { time: "06h", value: 3400, level: "warning" },
    { time: "09h", value: 18700, level: "critical" },
    { time: "12h", value: 14200, level: "warning" },
    { time: "15h", value: 9600, level: "warning" },
    { time: "18h", value: 21300, level: "critical" },
    { time: "21h", value: 7800, level: "warning" },
  ],
};

const LEVEL_BAR_CLASSES: Record<ChartLevel, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
};

const LEVEL_TEXT_CLASSES: Record<ChartLevel, string> = {
  critical: "text-critical",
  warning: "text-brand-orange",
};

const LEVEL_DOT_CLASSES: Record<ChartLevel, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
};

/** Formata `12400` como `12,4 mil`, no mesmo padrão do protótipo. */
function formatDeviceCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

export function IncidentsChart() {
  const [period, setPeriod] = useState<PeriodKey>("60");
  const buckets = PERIOD_DATASETS[period];
  const axisMax = Math.max(1000, Math.ceil(Math.max(...buckets.map((b) => b.value)) / 1000) * 1000);

  return (
    <Card accent="brand" accentPosition="top" padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Dispositivos afetados por horário</CardTitle>
          <CardDescription className="mt-1">
            Incidentes ativos empilhados por urgência
          </CardDescription>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-caption text-ink-muted">
              <span
                aria-hidden="true"
                className={cn("h-2.5 w-2.5 rounded-pill", LEVEL_DOT_CLASSES.critical)}
              />
              Crítico
            </span>
            <span className="flex items-center gap-1.5 text-caption text-ink-muted">
              <span
                aria-hidden="true"
                className={cn("h-2.5 w-2.5 rounded-pill", LEVEL_DOT_CLASSES.warning)}
              />
              Alto
            </span>
          </div>

          <Select
            aria-label="Período do gráfico"
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
      </div>

      <div className="mt-8 flex gap-4">
        <div className="flex h-56 flex-col justify-between text-caption text-ink-subtle">
          <span>{formatDeviceCount(axisMax)}</span>
          <span>{formatDeviceCount(axisMax / 2)}</span>
          <span>0</span>
        </div>

        <div className="relative h-56 flex-1">
          {/* Grades horizontais: linhas cheias nos níveis superiores e tracejada na base, como no protótipo. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            <div className="h-px bg-line-subtle" />
            <div className="h-px bg-line-subtle" />
            <div className="h-px border-t border-dashed border-line" />
          </div>

          <div className="absolute inset-0 flex items-stretch gap-4">
            {buckets.map((bucket) => (
              <div key={bucket.time} className="flex flex-1 flex-col items-center gap-2">
                <span
                  className={cn("text-caption font-semibold", LEVEL_TEXT_CLASSES[bucket.level])}
                >
                  {formatDeviceCount(bucket.value)}
                </span>
                <div className="flex w-full flex-1 items-end justify-center">
                  <div
                    className={cn(
                      "w-9 rounded-t-[1rem] transition-[height]",
                      LEVEL_BAR_CLASSES[bucket.level],
                    )}
                    style={{ height: `${Math.max(6, (bucket.value / axisMax) * 100)}%` }}
                  />
                </div>
                <span className="text-caption text-brand-blue">{bucket.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

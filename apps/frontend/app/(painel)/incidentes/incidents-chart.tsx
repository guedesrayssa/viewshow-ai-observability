/**
 * @file incidents-chart.tsx
 * Gráfico "Dispositivos por horário de início".
 *
 * Soma os dispositivos dos incidentes que começaram em cada hora e diferencia
 * visualmente os horários com incidente crítico (seção 5.3 do entendimento de
 * UX). O rótulo diz "horário de início" porque é o que a barra mede: uma série
 * contínua de dispositivos afetados exigiria medição por intervalo, que nenhuma
 * das APIs publica hoje.
 *
 * As barras crescem da base a cada leitura — a altura é o dado, e vê-la ser
 * construída dá a direção antes de ler o eixo — e o valor exato de cada faixa
 * fica no balão, sob demanda. A urgência aparece na cor e, em texto, no balão e
 * na legenda: a cor sozinha não diz qual faixa é crítica.
 */

"use client";

import {
  CHART_PERIOD_LABELS,
  type ChartBucket,
  type ChartLevel,
  type ChartPeriodKey,
} from "@/app/(painel)/incidentes/incidents-data";
import { BarChart, type BarTone } from "@/components/charts/bar-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";

const LEVEL_META: Record<
  ChartLevel,
  { tone: BarTone; label: string; dotClass: string }
> = {
  critical: {
    tone: "critical",
    label: "Urgência crítica",
    dotClass: "bg-critical",
  },
  warning: { tone: "warning", label: "Urgência alta", dotClass: "bg-brand-orange" },
};

export type IncidentsChartProps = {
  buckets?: ChartBucket[];
  period: ChartPeriodKey;
  onPeriodChange: (period: ChartPeriodKey) => void;
};

export function IncidentsChart({
  buckets,
  period,
  onPeriodChange,
}: IncidentsChartProps) {
  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Dispositivos por horário de início</CardTitle>
          <CardDescription className="mt-1">
            Soma dos dispositivos dos incidentes abertos em cada hora
          </CardDescription>
        </div>

        <Select
          aria-label="Período do gráfico"
          value={period}
          onValueChange={(value) => onPeriodChange(value as ChartPeriodKey)}
          options={(Object.keys(CHART_PERIOD_LABELS) as ChartPeriodKey[]).map(
            (key) => ({ value: key, label: CHART_PERIOD_LABELS[key] }),
          )}
        />
      </div>

      {!buckets ? (
        <Skeleton className="mt-5 h-56 w-full" />
      ) : (
        <BarChart
          className="mt-5"
          height={224}
          bars={buckets.map((bucket) => ({
            label: bucket.time,
            value: bucket.value,
            tone: LEVEL_META[bucket.level].tone,
            toneLabel: LEVEL_META[bucket.level].label,
          }))}
          formatValue={formatCompact}
          valueLabel="Dispositivos"
          ariaLabel={`Dispositivos por horário de início do incidente. ${buckets
            .map(
              (bucket) =>
                `${bucket.time}: ${formatCompact(bucket.value)}, ${LEVEL_META[bucket.level].label.toLowerCase()}`,
            )
            .join("; ")}.`}
        />
      )}

      <ul className="mt-4 flex flex-wrap items-center gap-4">
        {(Object.keys(LEVEL_META) as ChartLevel[]).map((level) => (
          <li
            key={level}
            className="flex items-center gap-1.5 text-caption text-ink-muted"
          >
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 rounded-pill", LEVEL_META[level].dotClass)}
            />
            {LEVEL_META[level].label}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * @file incidents-chart.tsx
 * Gráfico "Dispositivos afetados por horário".
 *
 * Mostra a evolução de dispositivos impactados e diferencia visualmente
 * incidentes críticos dos de alta severidade (seção 5.3 do entendimento de
 * UX). As barras crescem da base quando o gráfico entra na tela e a cada nova
 * leitura: a altura é o dado, e vê-la ser construída dá a direção do
 * movimento antes mesmo de ler o eixo.
 *
 * O desenho é feito com elementos do próprio layout — o projeto não tem
 * biblioteca de gráficos instalada e a série é curta.
 */

"use client";

import {
  CHART_PERIOD_LABELS,
  type ChartBucket,
  type ChartLevel,
  type ChartPeriodKey,
} from "@/app/(painel)/incidentes/incidents-data";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";

const LEVEL_BAR_CLASSES: Record<ChartLevel, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
};

const LEVEL_TEXT_CLASSES: Record<ChartLevel, string> = {
  critical: "text-critical-strong",
  warning: "text-warning-strong",
};

const LEVEL_DOT_CLASSES: Record<ChartLevel, string> = {
  critical: "bg-critical",
  warning: "bg-brand-orange",
};

/** Passo da cascata entre barras vizinhas, em milissegundos. */
const BAR_STEP = 60;

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
  const axisMax = buckets?.length
    ? Math.max(
        1000,
        Math.ceil(Math.max(...buckets.map((bucket) => bucket.value)) / 1000) * 1000,
      )
    : 1000;

  return (
    <Card accent="brand" accentPosition="top" padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Dispositivos afetados por horário</CardTitle>
          <CardDescription className="mt-1">
            Incidentes ativos empilhados por urgência
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-caption text-ink-muted">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2.5 w-2.5 rounded-pill",
                  LEVEL_DOT_CLASSES.critical,
                )}
              />
              Crítico
            </span>
            <span className="flex items-center gap-1.5 text-caption text-ink-muted">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2.5 w-2.5 rounded-pill",
                  LEVEL_DOT_CLASSES.warning,
                )}
              />
              Alto
            </span>
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
      </div>

      {!buckets ? (
        <Skeleton className="mt-8 h-56 w-full" />
      ) : (
        <div className="mt-8 flex gap-4">
          <div className="flex h-56 flex-col justify-between text-caption text-ink-subtle">
            <span>{formatCompact(axisMax)}</span>
            <span>{formatCompact(axisMax / 2)}</span>
            <span>0</span>
          </div>

          <div className="relative h-56 flex-1">
            {/* Grades horizontais: linhas cheias nos níveis superiores e
                tracejada na base, como no protótipo. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              <div className="h-px bg-line-subtle" />
              <div className="h-px bg-line-subtle" />
              <div className="h-px border-t border-dashed border-line" />
            </div>

            <div className="absolute inset-0 flex items-stretch gap-2 sm:gap-4">
              {buckets.map((bucket, index) => (
                <div
                  key={bucket.time}
                  className="group flex flex-1 flex-col items-center gap-2"
                >
                  <span
                    className={cn(
                      "animate-fade-in text-caption font-semibold",
                      LEVEL_TEXT_CLASSES[bucket.level],
                    )}
                    style={{ animationDelay: `${400 + index * BAR_STEP}ms` }}
                  >
                    {formatCompact(bucket.value)}
                  </span>

                  <div className="flex w-full flex-1 items-end justify-center">
                    <div
                      // A chave amarrada ao valor faz a barra ser redesenhada
                      // a cada leitura, em vez de deslizar para a nova altura.
                      key={bucket.value}
                      className={cn(
                        "bar-grow w-7 rounded-t-[1rem] sm:w-9",
                        "transition-[filter] duration-200 group-hover:brightness-110",
                        LEVEL_BAR_CLASSES[bucket.level],
                      )}
                      style={{
                        height: `${Math.max(6, (bucket.value / axisMax) * 100)}%`,
                        animationDelay: `${index * BAR_STEP}ms`,
                      }}
                    >
                      <span className="sr-only">
                        {bucket.time}: {formatCompact(bucket.value)} dispositivos
                      </span>
                    </div>
                  </div>

                  <span className="text-caption text-ink-brand">{bucket.time}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

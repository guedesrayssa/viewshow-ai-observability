/**
 * @file experience-health-card.tsx
 * Cartão "Saúde da experiência" da Visão Geral.
 *
 * Compara a série principal com a linha de base e marca a janela anômala. O
 * período é escolhido aqui, mas quem lê a telemetria é a tela: a mudança sobe
 * para ela e volta como dado novo, com a linha sendo redesenhada.
 */

"use client";

import {
  ChartLegend,
  TimeSeriesChart,
} from "@/components/charts/time-series-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TIME_RANGE_OPTIONS, type ExperiencePoint } from "@/lib/dashboard-data";
import { formatInteger, formatSignedPercent } from "@/lib/format";

export type ExperienceHealthCardProps = {
  series: ExperiencePoint[];
  baseline: number;
  anomalyRange: [number, number];
  peakIndex: number;
  timeRange: string;
  onTimeRangeChange: (value: string) => void;
};

export function ExperienceHealthCard({
  series,
  baseline,
  anomalyRange,
  peakIndex,
  timeRange,
  onTimeRangeChange,
}: ExperienceHealthCardProps) {
  const peakValue = series[peakIndex]?.value ?? 0;
  const versusBaseline = Math.round((peakValue / baseline - 1) * 100);

  return (
    <Card className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Saúde da experiência</CardTitle>
          <CardDescription>
            Erros por minuto, comparados à linha de base
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body-sm font-medium tabular-nums text-critical-strong">
            {formatInteger(peakValue)}/min · {formatSignedPercent(versusBaseline)}
          </span>
          <Select
            aria-label="Período do gráfico"
            value={timeRange}
            onValueChange={onTimeRangeChange}
            options={TIME_RANGE_OPTIONS}
          />
        </div>
      </div>

      <TimeSeriesChart
        // A chave amarrada à série faz o traço ser redesenhado a cada leitura,
        // em vez de saltar para a nova forma.
        key={series.map((point) => point.value).join(",")}
        className="mt-5"
        height={252}
        labels={series.map((point) => point.label)}
        series={[
          {
            id: "erros",
            label: "Erros",
            tone: "critical",
            area: true,
            values: series.map((point) => point.value),
          },
        ]}
        reference={{ value: baseline, label: "linha de base" }}
        highlight={anomalyRange}
        showPeak
        formatValue={formatInteger}
        tooltipNote={(index) => {
          const value = series[index]?.value ?? 0;
          const delta = Math.round((value / baseline - 1) * 100);
          return `${formatSignedPercent(delta)} vs. linha de base`;
        }}
        ariaLabel={`Erros por minuto ao longo do tempo, com pico de ${formatInteger(peakValue)} às ${series[peakIndex]?.label ?? ""}`}
      />

      <ChartLegend
        className="mt-3"
        items={[
          { label: "Erros por minuto", tone: "critical" },
          { label: "Janela anômala", tone: "warning" },
        ]}
      />
    </Card>
  );
}

/** Espaço reservado do cartão, enquanto a leitura não termina. */
export function ExperienceHealthCardSkeleton() {
  return (
    <Card className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
        <Skeleton className="h-11 w-40" />
      </div>
      <Skeleton className="mt-5 h-[252px] w-full" />
    </Card>
  );
}

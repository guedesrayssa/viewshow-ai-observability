/**
 * @file experience-health-card.tsx
 * Cartão "Saúde da experiência" da Visão Geral.
 *
 * Compara a série principal com a linha de base e marca a janela anômala. O
 * período é escolhido aqui, mas quem lê a telemetria é a tela: a mudança sobe
 * para ela e volta como dado novo, com a linha sendo redesenhada.
 */

"use client";

import { getPointXPercent, LineChart } from "@/components/dashboard/line-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TIME_RANGE_OPTIONS, type ExperiencePoint } from "@/lib/dashboard-data";
import { formatSignedPercent } from "@/lib/format";

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
  const anomalyCaptionLeft = getPointXPercent(peakIndex, series.length);
  const versusBaseline = Math.round((peakValue / baseline - 1) * 100);

  return (
    <Card accent="brand" accentPosition="top" className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Saúde da experiência</CardTitle>
          <CardDescription>
            Série principal comparada à linha de base
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body-sm font-medium text-critical-strong">
            {peakValue} erros/min · {formatSignedPercent(versusBaseline)}
          </span>
          <Select
            aria-label="Período do gráfico"
            value={timeRange}
            onValueChange={(value) => onTimeRangeChange(value)}
            options={TIME_RANGE_OPTIONS}
          />
        </div>
      </div>

      <div className="relative mt-4 h-72">
        {/* A chave amarrada à série faz o traço ser redesenhado a cada leitura,
            em vez de saltar para a nova forma. */}
        <LineChart
          key={series.map((point) => point.value).join(",")}
          id="experience-health"
          data={series}
          max={400}
          yTicks={[0, 100, 250, 400]}
          baseline={baseline}
          highlightRange={anomalyRange}
          peakIndex={peakIndex}
          peakLabel={`${peakValue}/min`}
          xTickEvery={2}
          ariaLabel={`Erros por minuto ao longo do tempo, com pico de ${peakValue} às ${series[peakIndex]?.label ?? ""}`}
        />
        <span
          className="absolute bottom-1 -translate-x-1/2 text-[11px] font-medium whitespace-nowrap text-critical-strong"
          style={{ left: `${anomalyCaptionLeft}%` }}
        >
          janela anômala
        </span>
      </div>
    </Card>
  );
}

/** Espaço reservado do cartão, enquanto a leitura não termina. */
export function ExperienceHealthCardSkeleton() {
  return (
    <Card accent="brand" accentPosition="top" className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
        <Skeleton className="h-10 w-40" />
      </div>
      <Skeleton className="mt-4 h-72 w-full" />
    </Card>
  );
}

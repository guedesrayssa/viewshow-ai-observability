/**
 * @file buffering-chart.tsx
 * Gráfico "Buffering após a versão 4.2.1".
 *
 * É a evidência quantitativa da hipótese: mostra o salto do buffer ratio logo
 * depois do deploy destacado. A ordem do desenho é a ordem do argumento —
 * primeiro o marco do deploy, depois a subida — e a comparação com a linha de
 * base aparece ponto a ponto, ao passar o cursor.
 */

"use client";

import {
  BUFFERING_PERIOD_LABELS,
  DEPLOY_INDEX,
  DEPLOY_LABEL,
  type BufferingPeriodKey,
  type BufferingPoint,
} from "@/app/(painel)/evidencias/evidence-data";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDecimal } from "@/lib/format";

export type BufferingChartProps = {
  points?: BufferingPoint[];
  period: BufferingPeriodKey;
  onPeriodChange: (period: BufferingPeriodKey) => void;
};

/** Escreve o buffer ratio com uma casa e o sinal de porcentagem. */
function formatRatio(value: number): string {
  return `${formatDecimal(value, 1)}%`;
}

export function BufferingChart({
  points,
  period,
  onPeriodChange,
}: BufferingChartProps) {
  return (
    <Card padding="lg" className="flex flex-1 flex-col">
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
          <Skeleton className="mt-5 h-48 w-full" />
          <Skeleton className="mt-3 h-3 w-56" />
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

  return (
    <>
      <TimeSeriesChart
        key={points.map((point) => point.value).join(",")}
        className="mt-5"
        height={192}
        labels={points.map((point) => point.time)}
        series={[
          {
            id: "buffer",
            label: "Buffer ratio",
            tone: "warning",
            area: true,
            values: points.map((point) => point.value),
          },
        ]}
        marker={{ index: deployIndex, label: DEPLOY_LABEL }}
        showPeak
        formatValue={formatRatio}
        tooltipNote={(index) =>
          index >= deployIndex
            ? `${formatDecimal(points[index].value / baseline, 1)}x a linha de base`
            : "antes do deploy"
        }
        ariaLabel={`Buffer ratio ao longo do tempo, com pico de ${formatRatio(peak.value)} às ${peak.time}, logo após o deploy 4.2.1`}
      />

      <p className="mt-3 text-caption font-medium tabular-nums text-critical-strong">
        +{multiplier}x vs. linha de base · forte evidência
      </p>
    </>
  );
}

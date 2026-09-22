/**
 * @file events-chart.tsx
 * Gráfico "Volume temporal dos eventos".
 *
 * Mostra a curva de eventos por minuto da camada normalizada, com o pico e a
 * janela anômala em destaque. O valor de cada minuto aparece ao passar o
 * cursor: em uma série de volume, o que interessa é comparar a altura com o
 * resto da curva, e o número exato só quando alguém pergunta.
 */

"use client";

import {
  formatVolume,
  formatVolumePerMinute,
  VOLUME_PERIOD_LABELS,
  type VolumePeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/eventos/events-data";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export type EventsChartProps = {
  series?: VolumeSeries;
  loading?: boolean;
  period: VolumePeriodKey;
  onPeriodChange: (period: VolumePeriodKey) => void;
};

export function EventsChart({ series, loading = false, period, onPeriodChange }: EventsChartProps) {
  return (
    <Card padding="lg">
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

      {loading ? (
        <Skeleton className="mt-5 h-56 w-full" />
      ) : !series || series.values.length === 0 ? (
        <p className="mt-5 flex h-56 items-center justify-center text-body-sm text-ink-muted">
          Volume temporal indisponível para esta janela.
        </p>
      ) : (
        <VolumePlot series={series} />
      )}
    </Card>
  );
}

function VolumePlot({ series }: { series: VolumeSeries }) {
  const { times, values, peakIndex, anomalyRange } = series;
  const baseline = values[0] ?? 0;

  const inAnomaly = (index: number) =>
    anomalyRange !== null && index >= anomalyRange[0] && index <= anomalyRange[1];

  return (
    <TimeSeriesChart
      key={values.join(",")}
      className="mt-5"
      height={224}
      labels={times}
      series={[
        {
          id: "volume",
          label: "Eventos",
          tone: "warning",
          area: true,
          values,
        },
      ]}
      highlight={anomalyRange ?? undefined}
      showPeak
      formatValue={formatVolume}
      tooltipNote={(index) =>
        inAnomaly(index)
          ? "dentro da janela anômala"
          : `${formatVolume(Math.abs(values[index] - baseline))} ${
              values[index] >= baseline ? "acima" : "abaixo"
            } do início da janela`
      }
      ariaLabel={`Volume de eventos por minuto. Parte de ${formatVolume(
        values[0],
      )}, atinge o pico de ${formatVolumePerMinute(values[peakIndex])} às ${
        times[peakIndex]
      } e termina em ${formatVolume(values[values.length - 1])}.${
        anomalyRange
          ? ` Janela anômala entre ${times[anomalyRange[0]]} e ${times[anomalyRange[1]]}.`
          : ""
      }`}
    />
  );
}

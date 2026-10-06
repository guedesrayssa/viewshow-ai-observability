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
  PERIOD_KEYS,
  PERIOD_LABELS,
  type VolumePeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/incidentes/_eventos/events-data";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export type EventsChartProps = {
  series?: VolumeSeries;
  status: "loading" | "ready" | "error";
  error?: string;
  period: VolumePeriodKey;
  /** Rótulo do recorte quando ele não é um dos períodos prontos. */
  periodLabel?: string;
  /**
   * Seletor próprio do gráfico. A tela de Eventos não passa: o gráfico segue o
   * período da lista, para os dois nunca mostrarem recortes diferentes.
   */
  onPeriodChange?: (period: VolumePeriodKey) => void;
};

export function EventsChart({
  series,
  status,
  error,
  period,
  periodLabel,
  onPeriodChange,
}: EventsChartProps) {
  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Volume temporal dos eventos</CardTitle>
          <CardDescription className="mt-1">
            Camada normalizada signal_point · eventos por minuto ·{" "}
            {(periodLabel ?? PERIOD_LABELS[period] ?? period).toLowerCase()}
          </CardDescription>
        </div>

        {onPeriodChange ? (
          <Select
            aria-label="Período do gráfico de volume"
            value={period}
            onValueChange={(value) => onPeriodChange(value as VolumePeriodKey)}
            options={PERIOD_KEYS.map((key) => ({
              value: key,
              label: PERIOD_LABELS[key],
            }))}
          />
        ) : null}
      </div>

      {status === "loading" ? (
        <Skeleton className="mt-5 h-56 w-full" />
      ) : !series ? (
        <Unavailable title="Volume indisponível" className="mt-5" minHeight={224}>
          {error ?? "O agregado temporal de eventos não foi publicado."}
        </Unavailable>
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

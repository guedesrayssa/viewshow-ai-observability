/**
 * @file processing-flow-chart.tsx
 * Gráfico "Fluxo de processamento".
 *
 * Mostra a evolução da métrica escolhida nos filtros técnicos, separada nas
 * etapas de ingestão e de processamento, com a linha da meta operacional e o
 * destaque do pico, conforme a seção 5.6 do entendimento de UX.
 *
 * As duas séries são escritas na ordem do pipeline — primeiro a ingestão, que é
 * a entrada, depois o processamento, que é onde a degradação aparece — e o
 * cursor lê as duas ao mesmo tempo, que é como a comparação entre etapas
 * costuma ser feita.
 */

"use client";

import { useState } from "react";

import {
  buildFlowChart,
  FLOW_METRICS,
  FLOW_WINDOW_LABELS,
  type FlowMetric,
  type FlowWindow,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";
import {
  ChartLegend,
  TimeSeriesChart,
} from "@/components/charts/time-series-chart";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

export type ProcessingFlowChartProps = {
  sources: TelemetrySource[];
  metric: FlowMetric;
};

export function ProcessingFlowChart({ sources, metric }: ProcessingFlowChartProps) {
  const [window, setWindow] = useState<FlowWindow>("30");

  const config = FLOW_METRICS[metric];
  const data = buildFlowChart(sources, metric, window);

  if (!data) return null;

  const lastIndex = data.processing.length - 1;

  return (
    <section aria-labelledby="fluxo-processamento">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle id="fluxo-processamento">Fluxo de processamento</CardTitle>
          <CardDescription className="mt-1">{config.description}</CardDescription>
          {data.historical && data.observedAt ? (
            <CardDescription className="mt-1">
              Última série disponível: {new Date(data.observedAt).toLocaleString("pt-BR")}
            </CardDescription>
          ) : null}
        </div>

        <Select
          aria-label="Janela do gráfico"
          value={window}
          onValueChange={(value) => setWindow(value as FlowWindow)}
          options={(Object.keys(FLOW_WINDOW_LABELS) as FlowWindow[]).map((key) => ({
            value: key,
            label: FLOW_WINDOW_LABELS[key],
          }))}
        />
      </div>

      <TimeSeriesChart
        key={`${metric}-${window}-${data.processing.join(",")}`}
        className="mt-5"
        height={224}
        labels={data.times}
        series={[
          {
            id: "processamento",
            label: "Processamento",
            tone: "critical",
            area: true,
            values: data.processing,
          },
          {
            id: "ingestao",
            label: "Ingestão",
            tone: "info",
            values: data.ingestion,
          },
        ]}
        max={config.axisMax}
        reference={{ value: config.target, label: "meta" }}
        showPeak
        formatValue={config.format}
        tooltipNote={(index) =>
          data.processing[index] > config.target
            ? "acima da meta operacional"
            : "dentro da meta"
        }
        ariaLabel={`${config.label} por etapa. Processamento parte de ${config.format(
          data.processing[0],
        )}, atinge o pico de ${config.format(data.processing[data.peakIndex])} às ${
          data.times[data.peakIndex]
        } e termina em ${config.format(data.processing[lastIndex])}. Ingestão parte de ${config.format(
          data.ingestion[0],
        )} e termina em ${config.format(
          data.ingestion[lastIndex],
        )}. A meta operacional é ${config.format(config.target)}.`}
      />

      <ChartLegend
        className="mt-3"
        items={[
          { label: "Processamento", tone: "critical" },
          { label: "Ingestão", tone: "info" },
          { label: "Meta", tone: "warning", dashed: true },
        ]}
      />
    </section>
  );
}

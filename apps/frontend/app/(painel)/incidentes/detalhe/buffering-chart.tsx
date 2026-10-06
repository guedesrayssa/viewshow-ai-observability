/**
 * @file buffering-chart.tsx
 * Gráfico "Taxa de travamento no recorte".
 *
 * É a evidência quantitativa da hipótese: a evolução da fração de tempo
 * travado ao longo da janela. Quando a origem registra o marco de um deploy,
 * ele entra como linha tracejada e a leitura ponto a ponto compara com o antes
 * — sem marco registrado, o gráfico mostra a série e nada mais: um deploy
 * desenhado sem fonte apontaria um culpado que ninguém mediu.
 */

"use client";

import { type BufferingPoint } from "@/app/(painel)/incidentes/detalhe/evidence-data";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDecimal } from "@/lib/format";

export type BufferingChartProps = {
  points?: BufferingPoint[];
  status: "loading" | "ready" | "error";
  error?: string;
  /** Marco de deploy na série, quando a origem o registra. */
  marker: { index: number; label: string } | null;
  historical?: boolean;
  observedAt?: string;
};

/** Escreve o buffer ratio com uma casa e o sinal de porcentagem. */
function formatRatio(value: number): string {
  return `${formatDecimal(value, 1)}%`;
}

export function BufferingChart({
  points,
  status,
  error,
  marker,
  historical,
  observedAt,
}: BufferingChartProps) {
  return (
    <Card padding="lg" className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Taxa de travamento no recorte</CardTitle>
          <CardDescription className="mt-1">
            Tempo travado sobre tempo assistido, em porcentagem
          </CardDescription>
          {historical && observedAt ? (
            <CardDescription className="mt-1">Última série disponível: {new Date(observedAt).toLocaleString("pt-BR")}</CardDescription>
          ) : null}
        </div>
      </div>

      {status === "loading" ? (
        <>
          <Skeleton className="mt-5 h-48 w-full" />
          <Skeleton className="mt-3 h-3 w-56" />
        </>
      ) : !points || points.length === 0 ? (
        <Unavailable title="Série indisponível" className="mt-5" minHeight={192}>
          {error ?? "A série de buffering não foi publicada para este incidente."}
        </Unavailable>
      ) : (
        <BufferingPlot points={points} marker={marker} />
      )}
    </Card>
  );
}

function BufferingPlot({
  points,
  marker,
}: {
  points: BufferingPoint[];
  marker: { index: number; label: string } | null;
}) {
  const deployIndex =
    marker === null ? null : Math.min(marker.index, points.length - 1);

  const peakIndex = points.reduce(
    (best, point, index) => (point.value > points[best].value ? index : best),
    0,
  );
  const peak = points[peakIndex];
  const start = points[0].value;
  // A comparação com o primeiro ponto só faz sentido quando ele não é zero e
  // quando existe um marco que divida a série em antes e depois.
  const multiplier =
    deployIndex !== null && start > 0 ? formatDecimal(peak.value / start, 1) : null;

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
            label: "Taxa de travamento",
            tone: "warning",
            area: true,
            values: points.map((point) => point.value),
          },
        ]}
        marker={
          deployIndex === null
            ? undefined
            : { index: deployIndex, label: marker?.label ?? "" }
        }
        showPeak
        formatValue={formatRatio}
        tooltipNote={
          deployIndex === null || start <= 0
            ? undefined
            : (index) =>
                index >= deployIndex
                  ? `${formatDecimal(points[index].value / start, 1)}x o início da janela`
                  : "antes do deploy"
        }
        ariaLabel={`Taxa de travamento ao longo do tempo, com pico de ${formatRatio(peak.value)} às ${peak.time}`}
      />

      {multiplier !== null ? (
        <p className="mt-3 text-caption font-medium tabular-nums text-critical-strong">
          +{multiplier}x vs. início da janela
        </p>
      ) : null}
    </>
  );
}

"use client";

import { useMemo, useState } from "react";
import { GeographicMap } from "@/app/(painel)/monitoramento/geographic-map";
import {
  KpiCard,
  KpiCardSkeleton,
} from "@/app/(painel)/monitoramento/kpi-card";
import { ServiceHealthCard } from "@/app/(painel)/monitoramento/service-health-card";
import {
  STATES,
  WINDOW_LABELS,
  formatIngestion,
  formatLatencySeconds,
  formatQueue,
  type StateTelemetry,
  type WindowKey,
} from "@/app/(painel)/monitoramento/telemetry-data";
import {
  fetchMonitoringOverview,
  type MonitoringResponse,
  type ServiceTopology,
} from "@/app/(painel)/monitoramento/telemetry-resource";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource, type UseResourceResult } from "@/hooks/use-resource";
import { formatInteger } from "@/lib/format";

const REFRESH_MS = 20_000;
const KPI_TONES = ["info", "critical", "warning", "critical"] as const;

function geographicStates(data: MonitoringResponse): StateTelemetry[] {
  return data.geography.areas.flatMap((area) => {
    const shape = STATES.find((state) => state.id === area.code);
    const instability = area.values.instabilityRatio.value;
    const latency = area.values.latencyP95.value;
    const loss = area.values.eventLossRatio.value;
    const sessions = area.observedSessions.value;
    if (
      !shape ||
      instability === null ||
      latency === null ||
      loss === null ||
      sessions === null
    )
      return [];
    return [
      {
        id: area.code,
        name: area.name,
        region: area.region,
        path: shape.path,
        values: {
          instabilidade: instability * 100,
          latencia: latency / 1000,
          perda: loss * 100,
        },
        sessions: sessions / 1000,
        topSource: area.values.instabilityRatio.measurement.source,
      },
    ];
  });
}

export function MonitoringView() {
  const [window, setWindow] = useState<WindowKey>("360");
  const [source, setSource] = useState("all");
  const monitoring = useResource(
    () =>
      fetchMonitoringOverview(window, source === "all" ? undefined : source),
    [window, source],
    { refreshMs: REFRESH_MS },
  );
  const data = monitoring.data;
  const states = useMemo(() => (data ? geographicStates(data) : []), [data]);
  const topology: UseResourceResult<ServiceTopology> = {
    ...monitoring,
    data: data?.topology,
  };
  const flow = data?.flow;
  const flowSeries =
    flow?.series.filter((series) => series.points.length > 0) ?? [];
  const labels =
    flowSeries[0]?.points.map((point) =>
      new Date(point.timestamp).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ) ?? [];
  const flowDivisor = flow?.unit === "ms" ? 1000 : 1_000_000;
  const flowFormat =
    flow?.unit === "ms" ? formatLatencySeconds : formatIngestion;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Monitoramento"
        subtitle="Saúde técnica, distribuição e concentração geográfica"
        status={
          <DataStatus
            source={monitoring.source}
            availability={monitoring.availability}
            warnings={monitoring.warnings}
            fetchedAt={monitoring.fetchedAt}
            refreshing={monitoring.refreshing}
            error={monitoring.error}
            onRefresh={monitoring.refresh}
          />
        }
      />

      {monitoring.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler o pipeline">
          {monitoring.error}
        </Alert>
      ) : null}

      <Card padding="md" className="flex flex-wrap items-center gap-3">
        <p className="text-label text-ink-muted">Filtros técnicos</p>
        <Select
          aria-label="Filtrar por fonte"
          value={source}
          onValueChange={setSource}
          disabled={
            !data?.capabilities.filtering.supportedDimensions.includes("source")
          }
          options={[
            { value: "all", label: "Fonte: todas" },
            ...(data?.sources ?? []).map((item) => ({
              value: item.id,
              label: `Fonte: ${item.name}`,
            })),
          ]}
        />
        <Select
          aria-label="Métrica em análise"
          value={flow?.metric ?? "processing_latency"}
          onValueChange={() => {}}
          disabled
          options={[
            {
              value: flow?.metric ?? "processing_latency",
              label:
                flow?.metric === "ingestion_rate"
                  ? "Métrica: ingestão"
                  : "Métrica: latência",
            },
          ]}
        />
        <Select
          aria-label="Filtrar por worker"
          value="all"
          onValueChange={() => {}}
          disabled
          options={[{ value: "all", label: "Worker: todos" }]}
        />
        <Select
          aria-label="Janela de comparação"
          value={window}
          onValueChange={(value) => setWindow(value as WindowKey)}
          options={(Object.keys(WINDOW_LABELS) as WindowKey[]).map((key) => ({
            value: key,
            label: `Janela: ${WINDOW_LABELS[key]}`,
          }))}
        />
        {data?.sources
          .filter((source) => source.state === "delayed")
          .map((source) => (
            <Badge key={source.id} tone="critical" withDot role="status">
              {source.name} com atraso
              {source.lagSeconds !== null
                ? ` de ${Math.round(source.lagSeconds)} s`
                : ""}
            </Badge>
          ))}
      </Card>

      {monitoring.status === "loading" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {KPI_TONES.map((tone, index) => (
              <KpiCardSkeleton key={index} tone={tone} />
            ))}
          </div>
          <Skeleton className="h-96 w-full" />
        </>
      ) : !data ? (
        <Unavailable title="Monitoramento indisponível" minHeight={240}>
          A projeção do pipeline ainda não foi publicada para esta janela.
        </Unavailable>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Taxa de ingestão"
              value={
                data.kpis.ingestionRate.value === null
                  ? null
                  : data.kpis.ingestionRate.value / 1_000_000
              }
              format={formatIngestion}
              note={
                data.kpis.ingestionRate.value === null
                  ? "sem medição"
                  : "medição publicada"
              }
              tone="info"
              noteTone="neutral"
            />
            <KpiCard
              label="Latência de processamento"
              value={
                data.kpis.processingLatencyP95.value === null
                  ? null
                  : data.kpis.processingLatencyP95.value / 1000
              }
              format={formatLatencySeconds}
              note={
                data.kpis.processingLatencyP95.value === null
                  ? "sem medição"
                  : "p95 publicado"
              }
              tone="critical"
              noteTone="neutral"
            />
            <KpiCard
              label="Profundidade da fila"
              value={
                data.kpis.queueDepth.value === null
                  ? null
                  : data.kpis.queueDepth.value / 1000
              }
              format={formatQueue}
              note={
                data.kpis.queueDepth.value === null
                  ? "não se aplica ao pipeline em lote"
                  : "medição publicada"
              }
              tone="warning"
              noteTone="neutral"
            />
            <KpiCard
              label="Fila de falhas · DLQ"
              value={data.kpis.deadLetterQueue.value}
              format={formatInteger}
              note={
                data.kpis.deadLetterQueue.value === null
                  ? "não se aplica ao pipeline em lote"
                  : "medição publicada"
              }
              tone="critical"
              noteTone="neutral"
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card padding="lg">
              <CardTitle>Fluxo de processamento</CardTitle>
              <CardDescription className="mt-1">
                {flow?.metric === "ingestion_rate"
                  ? "Taxa de ingestão"
                  : "Latência de processamento"}{" "}
                · {WINDOW_LABELS[window]}
              </CardDescription>
              {flowSeries.length > 0 && labels.length > 0 ? (
                <TimeSeriesChart
                  className="mt-5"
                  height={224}
                  labels={labels}
                  series={flowSeries.map((series, index) => ({
                    id: series.stage,
                    label: series.name,
                    tone:
                      index === 0 ? ("critical" as const) : ("info" as const),
                    area: index === 0,
                    values: series.points.map(
                      (point) => point.value / flowDivisor,
                    ),
                  }))}
                  reference={
                    flow?.target
                      ? {
                          value: flow.target.value / flowDivisor,
                          label: "meta",
                        }
                      : undefined
                  }
                  showPeak
                  formatValue={flowFormat}
                  ariaLabel={`Fluxo de ${flow?.metric === "ingestion_rate" ? "ingestão" : "processamento"} na janela de ${WINDOW_LABELS[window]}.`}
                />
              ) : (
                <Unavailable
                  title="Série temporal sem medição"
                  className="mt-5"
                  minHeight={224}
                >
                  A fonte ainda não publicou pontos para esta janela.
                </Unavailable>
              )}

              <h3 className="mt-8 text-title text-ink">
                Fontes e qualidade da telemetria
              </h3>
              {data.sources.length === 0 ? (
                <p className="mt-4 text-body-sm text-ink-muted">
                  Nenhuma fonte publicada.
                </p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-body-sm">
                    <thead>
                      <tr className="text-caption text-ink-subtle">
                        <th className="pb-3">Fonte</th>
                        <th className="pb-3">Atualização</th>
                        <th className="pb-3">Cobertura</th>
                        <th className="pb-3">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sources.map((source) => (
                        <tr
                          key={source.id}
                          className="border-t border-line-subtle"
                        >
                          <th className="py-3 font-medium">{source.name}</th>
                          <td className="py-3">
                            {source.observedThrough
                              ? new Date(source.observedThrough).toLocaleString(
                                  "pt-BR",
                                )
                              : "—"}
                          </td>
                          <td className="py-3">
                            {source.coverage.value === null
                              ? "—"
                              : `${Math.round(source.coverage.value * 100)}%`}
                          </td>
                          <td className="py-3">
                            <Badge
                              tone={
                                source.state === "stable"
                                  ? "success"
                                  : source.state === "delayed"
                                    ? "critical"
                                    : "warning"
                              }
                            >
                              {
                                (
                                  {
                                    stable: "Estável",
                                    delayed: "Atrasada",
                                    partial: "Parcial",
                                    unavailable: "Indisponível",
                                  } as const
                                )[source.state]
                              }
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {states.length > 0 ? (
              <GeographicMap states={states} />
            ) : (
              <Card padding="lg">
                <CardTitle>Concentração geográfica</CardTitle>
                <Unavailable title="Sem recorte por estado" className="mt-5">
                  As métricas geográficas ainda não foram publicadas com todas
                  as medidas necessárias.
                </Unavailable>
              </Card>
            )}
          </div>

          <ServiceHealthCard topology={topology} />
        </>
      )}
    </div>
  );
}

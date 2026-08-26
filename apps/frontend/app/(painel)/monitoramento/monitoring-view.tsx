/**
 * @file monitoring-view.tsx
 * Filtros técnicos, indicadores e painéis da tela de Monitoramento.
 *
 * Cobre a seção 5.6 do entendimento de UX: filtros por fonte, métrica, worker
 * e janela de tempo; alerta de atraso de fonte; cartões de ingestão, latência,
 * fila e DLQ; gráfico do fluxo de processamento; tabela de fontes; e o mapa de
 * concentração geográfica. Apoia as US-ENG-04, US-ENG-05 e US-PM-02 a
 * US-PM-05.
 *
 * Os cartões, o gráfico e a tabela derivam das mesmas fontes selecionadas,
 * então os filtros mudam de fato todos os painéis. É a tela que mais se
 * beneficia da releitura automática: é ela que mostra a fila crescendo antes
 * que alguém precise perguntar.
 */

"use client";

import { useMemo, useState } from "react";

import { GeographicMap } from "@/app/(painel)/monitoramento/geographic-map";
import {
  KpiCard,
  KpiCardSkeleton,
  type KpiNoteTone,
  type KpiTone,
} from "@/app/(painel)/monitoramento/kpi-card";
import { ProcessingFlowChart } from "@/app/(painel)/monitoramento/processing-flow-chart";
import { SourcesTable } from "@/app/(painel)/monitoramento/sources-table";
import {
  aggregateKpis,
  FLOW_METRICS,
  formatIngestion,
  formatLatencySeconds,
  formatQueue,
  formatSeconds,
  formatTrend,
  LATENCY_TARGET,
  WINDOW_LABELS,
  type FlowMetric,
  type WindowKey,
} from "@/app/(painel)/monitoramento/telemetry-data";
import {
  fetchGeographicConcentration,
  fetchTelemetrySources,
} from "@/app/(painel)/monitoramento/telemetry-resource";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { XIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { formatInteger } from "@/lib/format";

/** Variação a partir da qual a ingestão deixa de ser lida como estável. */
const STABLE_TREND = 10;

/** Releitura automática: o pipeline muda de estado em segundos. */
const REFRESH_MS = 20_000;

/** Faixas dos quatro indicadores, usadas também no espaço reservado. */
const KPI_TONES: KpiTone[] = ["info", "critical", "warning", "critical"];

/** Descreve a variação da ingestão em texto, ao lado do percentual. */
function describeTrend(trend: number): { text: string; tone: KpiNoteTone } {
  if (Math.abs(trend) < STABLE_TREND) return { text: "estável", tone: "success" };
  return trend > 0
    ? { text: "em alta", tone: "warning" }
    : { text: "em queda", tone: "critical" };
}

export function MonitoringView() {
  const [source, setSource] = useState<string>("all");
  const [metric, setMetric] = useState<FlowMetric>("latencia");
  const [worker, setWorker] = useState<string>("all");
  const [window, setWindow] = useState<WindowKey>("15");

  const telemetry = useResource((revision) => fetchTelemetrySources(revision), [], {
    refreshMs: REFRESH_MS,
  });

  const geography = useResource(
    (revision) => fetchGeographicConcentration(revision),
    [],
    { refreshMs: REFRESH_MS },
  );

  const allSources = useMemo(() => telemetry.data ?? [], [telemetry.data]);
  const workers = useMemo(
    () => Array.from(new Set(allSources.map((item) => item.worker))).sort(),
    [allSources],
  );

  const hasActiveFilters = source !== "all" || worker !== "all" || window !== "15";

  const selectedSources = useMemo(
    () =>
      allSources.filter(
        (item) =>
          (source === "all" || item.id === source) &&
          (worker === "all" || item.worker === worker),
      ),
    [allSources, source, worker],
  );

  const kpis = aggregateKpis(selectedSources, window);

  /* O aviso de atraso só aparece quando a fonte atrasada está no recorte. */
  const delayed = selectedSources.find((item) => item.state === "atrasado");

  function clearFilters() {
    setSource("all");
    setWorker("all");
    setWindow("15");
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Monitoramento"
        subtitle="Saúde técnica, distribuição e concentração geográfica"
        status={
          <DataStatus
            source={telemetry.source}
            fetchedAt={telemetry.fetchedAt}
            refreshing={telemetry.refreshing}
            error={telemetry.error}
            onRefresh={telemetry.refresh}
          />
        }
      />

      {telemetry.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler o pipeline">
          {telemetry.error} Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <Reveal delay={80}>
        <Card padding="md">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-label text-ink-muted">Filtros técnicos</p>

            <Select
              aria-label="Filtrar por fonte"
              value={source}
              onValueChange={(value) => setSource(value)}
              options={[
                { value: "all", label: `Fonte: todas` },
                ...allSources.map((item) => ({
                  value: item.id,
                  label: `Fonte: ${item.name}`,
                })),
              ]}
            />

            <Select
              aria-label="Métrica em análise"
              value={metric}
              onValueChange={(value) => setMetric(value as FlowMetric)}
              options={(Object.keys(FLOW_METRICS) as FlowMetric[]).map((key) => ({
                value: key,
                label: `Métrica: ${FLOW_METRICS[key].label}`,
              }))}
            />

            <Select
              aria-label="Filtrar por worker"
              value={worker}
              onValueChange={(value) => setWorker(value)}
              options={[
                { value: "all", label: `Worker: todos` },
                ...workers.map((name) => ({
                  value: name,
                  label: `Worker: ${name}`,
                })),
              ]}
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

            {delayed ? (
              <Badge
                tone="critical"
                withDot
                role="status"
                className="animate-fade-in"
              >
                {delayed.name} com atraso de{" "}
                {formatSeconds(delayed.updatedSecondsAgo)}
              </Badge>
            ) : null}

            {hasActiveFilters ? (
              <Button variant="quiet" size="sm" onClick={clearFilters}>
                <XIcon size={16} />
                Limpar filtros
              </Button>
            ) : null}
          </div>
        </Card>
      </Reveal>

      {telemetry.status === "loading" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {KPI_TONES.map((tone, index) => (
              <KpiCardSkeleton key={index} tone={tone} />
            ))}
          </div>
          <Skeleton className="h-96 w-full" />
        </>
      ) : kpis === null ? (
        <Card padding="lg">
          <p className="text-center text-body-sm text-ink-muted">
            Nenhuma fonte corresponde aos filtros aplicados.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Reveal index={0}>
              <KpiCard
                label="Taxa de ingestão"
                value={kpis.ingestionPerMinute}
                format={formatIngestion}
                note={`${formatTrend(kpis.ingestionTrend)} ${describeTrend(kpis.ingestionTrend).text}`}
                tone="info"
                noteTone={describeTrend(kpis.ingestionTrend).tone}
              />
            </Reveal>

            <Reveal index={1}>
              <KpiCard
                label="Latência de processamento"
                value={Math.round(kpis.processingLatency)}
                format={formatLatencySeconds}
                note={`meta ≤ ${formatLatencySeconds(LATENCY_TARGET)}`}
                tone="critical"
                noteTone={
                  kpis.processingLatency <= LATENCY_TARGET ? "success" : "critical"
                }
              />
            </Reveal>

            <Reveal index={2}>
              <KpiCard
                label="Profundidade da fila"
                value={kpis.queueDepth}
                format={formatQueue}
                note={`${formatTrend(kpis.queueTrend)} / ${WINDOW_LABELS[window]}`}
                tone="warning"
                noteTone={kpis.queueTrend > 0 ? "warning" : "success"}
              />
            </Reveal>

            <Reveal index={3}>
              <KpiCard
                label="Fila de falhas · DLQ"
                value={kpis.deadLetters}
                format={formatInteger}
                note={
                  kpis.newDeadLetters === 1
                    ? "1 nova mensagem"
                    : `${formatInteger(kpis.newDeadLetters)} novas mensagens`
                }
                tone="critical"
                noteTone={kpis.newDeadLetters > 0 ? "critical" : "success"}
              />
            </Reveal>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Reveal delay={220} className="flex">
              <Card padding="lg" className="flex-1">
                <div className="flex flex-col gap-8">
                  <ProcessingFlowChart sources={selectedSources} metric={metric} />
                  <SourcesTable sources={selectedSources} />
                </div>
              </Card>
            </Reveal>

            <Reveal delay={300} className="flex">
              <GeographicMap states={geography.data} />
            </Reveal>
          </div>
        </>
      )}
    </div>
  );
}

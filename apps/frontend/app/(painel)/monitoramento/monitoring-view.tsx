/**
 * @file monitoring-view.tsx
 * Filtros técnicos, indicadores e painéis da tela de Monitoramento.
 *
 * Cobre a seção 5.6 do entendimento de UX: filtros por fonte, métrica,
 * worker e janela de tempo; alerta de atraso de fonte; cartões de ingestão,
 * latência, fila e DLQ; gráfico do fluxo de processamento; tabela de fontes;
 * e o mapa de concentração geográfica. Apoia as US-ENG-04, US-ENG-05 e
 * US-PM-02 a US-PM-05.
 *
 * Os cartões, o gráfico e a tabela derivam das mesmas fontes selecionadas,
 * então os filtros mudam de fato todos os painéis. Os dados são um exemplo
 * fixo, enquanto a integração com a telemetria não existe.
 */

"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { XIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";

import { GeographicMap } from "@/app/(painel)/monitoramento/geographic-map";
import { KpiCard, type KpiNoteTone } from "@/app/(painel)/monitoramento/kpi-card";
import { ProcessingFlowChart } from "@/app/(painel)/monitoramento/processing-flow-chart";
import { SourcesTable } from "@/app/(painel)/monitoramento/sources-table";
import {
  aggregateKpis,
  DELAYED_SOURCE,
  FLOW_METRICS,
  formatIngestion,
  formatQueue,
  formatLatencySeconds,
  formatSeconds,
  formatTrend,
  LATENCY_TARGET,
  SOURCES,
  WINDOW_LABELS,
  WORKERS,
  type FlowMetric,
  type WindowKey,
} from "@/app/(painel)/monitoramento/telemetry-data";

/** Variação a partir da qual a ingestão deixa de ser lida como estável. */
const STABLE_TREND = 10;

/** Descreve a variação da ingestão em texto, ao lado do percentual. */
function describeTrend(trend: number): { text: string; tone: KpiNoteTone } {
  if (Math.abs(trend) < STABLE_TREND) return { text: "estável", tone: "success" };
  return trend > 0 ? { text: "em alta", tone: "warning" } : { text: "em queda", tone: "critical" };
}

export function MonitoringView() {
  const [source, setSource] = useState<string>("all");
  const [metric, setMetric] = useState<FlowMetric>("latencia");
  const [worker, setWorker] = useState<string>("all");
  const [window, setWindow] = useState<WindowKey>("15");

  const hasActiveFilters = source !== "all" || worker !== "all" || window !== "15";

  const selectedSources = useMemo(
    () =>
      SOURCES.filter(
        (item) =>
          (source === "all" || item.id === source) &&
          (worker === "all" || item.worker === worker),
      ),
    [source, worker],
  );

  const kpis = aggregateKpis(selectedSources, window);

  /* O aviso de atraso só aparece quando a fonte atrasada está no recorte. */
  const delayed = DELAYED_SOURCE;
  const showDelay =
    delayed !== undefined && selectedSources.some((item) => item.id === delayed.id);

  function clearFilters() {
    setSource("all");
    setWorker("all");
    setWindow("15");
  }

  return (
    <div className="flex flex-col gap-6">
      <Card padding="md">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-label text-ink-muted">Filtros técnicos</p>

          <Select
            aria-label="Filtrar por fonte"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="all">Fonte: todas</option>
            {SOURCES.map((item) => (
              <option key={item.id} value={item.id}>
                Fonte: {item.name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Métrica em análise"
            value={metric}
            onChange={(event) => setMetric(event.target.value as FlowMetric)}
          >
            {(Object.keys(FLOW_METRICS) as FlowMetric[]).map((key) => (
              <option key={key} value={key}>
                Métrica: {FLOW_METRICS[key].label}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Filtrar por worker"
            value={worker}
            onChange={(event) => setWorker(event.target.value)}
          >
            <option value="all">Worker: todos</option>
            {WORKERS.map((name) => (
              <option key={name} value={name}>
                Worker: {name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Janela de comparação"
            value={window}
            onChange={(event) => setWindow(event.target.value as WindowKey)}
          >
            {(Object.keys(WINDOW_LABELS) as WindowKey[]).map((key) => (
              <option key={key} value={key}>
                Janela: {WINDOW_LABELS[key]}
              </option>
            ))}
          </Select>

          {showDelay && delayed ? (
            <Badge tone="critical" withDot role="status">
              {delayed.name} com atraso de {formatSeconds(delayed.updatedSecondsAgo)}
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

      {kpis === null ? (
        <Card padding="lg">
          <p className="text-center text-body-sm text-ink-muted">
            Nenhuma fonte corresponde aos filtros aplicados.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Taxa de ingestão"
              value={formatIngestion(kpis.ingestionPerMinute)}
              note={`${formatTrend(kpis.ingestionTrend)} ${describeTrend(kpis.ingestionTrend).text}`}
              tone="info"
              noteTone={describeTrend(kpis.ingestionTrend).tone}
            />

            <KpiCard
              label="Latência de processamento"
              value={formatLatencySeconds(Math.round(kpis.processingLatency))}
              note={`meta ≤ ${formatLatencySeconds(LATENCY_TARGET)}`}
              tone="critical"
              noteTone={kpis.processingLatency <= LATENCY_TARGET ? "success" : "critical"}
            />

            <KpiCard
              label="Profundidade da fila"
              value={formatQueue(kpis.queueDepth)}
              note={`${formatTrend(kpis.queueTrend)} / ${WINDOW_LABELS[window]}`}
              tone="warning"
              noteTone={kpis.queueTrend > 0 ? "warning" : "success"}
            />

            <KpiCard
              label="Fila de falhas · DLQ"
              value={kpis.deadLetters.toLocaleString("pt-BR")}
              note={
                kpis.newDeadLetters === 1
                  ? "1 nova mensagem"
                  : `${kpis.newDeadLetters.toLocaleString("pt-BR")} novas mensagens`
              }
              tone="critical"
              noteTone={kpis.newDeadLetters > 0 ? "critical" : "success"}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card accent="brand" accentPosition="top" padding="lg">
              <div className="flex flex-col gap-8">
                <ProcessingFlowChart sources={selectedSources} metric={metric} />
                <SourcesTable sources={selectedSources} />
              </div>
            </Card>

            <GeographicMap />
          </div>
        </>
      )}
    </div>
  );
}

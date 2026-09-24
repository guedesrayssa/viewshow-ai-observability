/** Leitura da projeção de monitoramento. Medidas ausentes permanecem nulas. */
import {
  SOURCES,
  STATES,
  aggregateKpis,
  buildFlowChart,
  type FlowWindow,
  type WindowKey,
} from "@/app/(painel)/monitoramento/telemetry-data";
import { loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

export type Measured = {
  value: number | null;
  unit: string;
  measurement: { status: string; source: string };
};

export type MonitoringKpi = Measured & {
  status: "healthy" | "warning" | "critical" | "unknown";
  newInWindow?: number | null;
};

export type ServiceHealth = {
  service: string;
  status: "healthy" | "degraded" | "critical";
  calls: number;
  errors: number;
  errorRate: number;
  latencyP95: number | null;
};

export type ServiceDependency = {
  source: string;
  target: string;
  calls: number;
  errorRate: number;
};

export type ServiceTopology = {
  status: "available" | "partial" | "unavailable";
  provenance: "traces" | "seed-carga";
  services: ServiceHealth[];
  dependencies: ServiceDependency[];
};

export type MonitoringResponse = {
  capabilities: {
    filtering: { supportedDimensions: string[] };
    pipelineRuntime: { metrics: Record<string, string> };
  };
  kpis: {
    ingestionRate: MonitoringKpi;
    processingLatencyP95: MonitoringKpi;
    queueDepth: MonitoringKpi;
    deadLetterQueue: MonitoringKpi;
  };
  flow: {
    metric: "ingestion_rate" | "processing_latency";
    unit: string;
    measurement: { status: string; source: string };
    target: { operator: string; value: number } | null;
    series: Array<{
      stage: string;
      name: string;
      points: Array<{ timestamp: string; value: number }>;
    }>;
    peak: { timestamp: string; stage: string; value: number } | null;
  };
  sources: Array<{
    id: string;
    name: string;
    workers: string[];
    observedThrough: string | null;
    lagSeconds: number | null;
    state: "stable" | "delayed" | "partial" | "unavailable";
    coverage: Measured;
    ingestionRate?: MonitoringKpi;
    processingLatencyP95?: MonitoringKpi;
  }>;
  geography: {
    areas: Array<{
      code: string;
      name: string;
      region: string;
      observedSessions: Measured;
      values: {
        instabilityRatio: Measured;
        latencyP95: Measured;
        eventLossRatio: Measured;
      };
    }>;
  };
  topology?: ServiceTopology;
};

function monitoringWindow(minutes: string): string {
  return (
    (
      { "15": "15m", "30": "30m", "60": "1h", "360": "6h" } as Record<
        string,
        string
      >
    )[minutes] ?? minutes
  );
}

function exampleProjection(window: string): MonitoringResponse {
  const selectedWindow = (
    window in { "15": 1, "30": 1, "60": 1, "360": 1 } ? window : "360"
  ) as WindowKey;
  const kpis = aggregateKpis(SOURCES, selectedWindow)!;
  const chartWindow: FlowWindow =
    selectedWindow === "15" || selectedWindow === "30" ? selectedWindow : "60";
  const chart = buildFlowChart(SOURCES, "latencia", chartWindow)!;
  const now = Date.now();
  const measurement = { status: "measured", source: "exemplo" };
  const measured = (value: number | null, unit: string): Measured => ({
    value,
    unit,
    measurement,
  });
  const kpi = (value: number | null, unit: string): MonitoringKpi => ({
    ...measured(value, unit),
    status: value === null ? "unknown" : "healthy",
  });
  const timestamps = chart.times.map((_, index) =>
    new Date(now - (chart.times.length - index - 1) * 5 * 60_000).toISOString(),
  );
  const series = [
    { stage: "processing", name: "Processamento", values: chart.processing },
    { stage: "ingestion", name: "Ingestão", values: chart.ingestion },
  ].map((item) => ({
    stage: item.stage,
    name: item.name,
    points: item.values.map((value, index) => ({
      timestamp: timestamps[index]!,
      value: value * 1000,
    })),
  }));
  return {
    capabilities: {
      filtering: { supportedDimensions: [] },
      pipelineRuntime: {
        metrics: {
          ingestionRate: "available",
          processingLatencyP95: "available",
          queueDepth: "available",
          deadLetterQueue: "available",
        },
      },
    },
    kpis: {
      ingestionRate: kpi(
        kpis.ingestionPerMinute * 1_000_000,
        "events_per_minute",
      ),
      processingLatencyP95: kpi(kpis.processingLatency * 1000, "ms"),
      queueDepth: kpi(kpis.queueDepth * 1000, "messages"),
      deadLetterQueue: kpi(kpis.deadLetters, "messages"),
    },
    flow: {
      metric: "processing_latency",
      unit: "ms",
      measurement,
      target: { operator: "less_than_or_equal", value: 120_000 },
      series,
      peak: {
        timestamp: timestamps[chart.peakIndex]!,
        stage: "processing",
        value: chart.processing[chart.peakIndex]! * 1000,
      },
    },
    sources: SOURCES.map((source) => ({
      id: source.id,
      name: source.name,
      workers: [source.worker],
      observedThrough: new Date(
        now - source.updatedSecondsAgo * 1000,
      ).toISOString(),
      lagSeconds: source.updatedSecondsAgo,
      state:
        source.state === "estavel"
          ? ("stable" as const)
          : source.state === "atrasado"
            ? ("delayed" as const)
            : ("partial" as const),
      coverage: measured(source.coverage / 100, "ratio"),
      ingestionRate: kpi(
        source.ingestionPerMinute * 1_000_000,
        "events_per_minute",
      ),
      processingLatencyP95: kpi(source.processingLatency * 1000, "ms"),
    })),
    geography: {
      areas: STATES.map((state) => ({
        code: state.id,
        name: state.name,
        region: state.region,
        observedSessions: measured(state.sessions * 1000, "sessions"),
        values: {
          instabilityRatio: measured(state.values.instabilidade / 100, "ratio"),
          latencyP95: measured(state.values.latencia * 1000, "ms"),
          eventLossRatio: measured(state.values.perda / 100, "ratio"),
        },
      })),
    },
  };
}

export function fetchMonitoringOverview(
  window: string,
  source?: string,
): Promise<Resource<MonitoringResponse>> {
  return loadResource<MonitoringResponse, MonitoringResponse>({
    path: ENDPOINTS.monitoringOverview,
    params: { window: monitoringWindow(window), source },
    map: (response) => response,
    fallback: () => exampleProjection(window),
  });
}

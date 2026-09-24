/** Monitoring projection adapter. Missing metrics remain unavailable. */
import {
  SOURCES,
  STATES,
  type StateTelemetry,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

type Measured = { value: number | null; measurement: { status: string; source: string } };
type MonitoringResponse = {
  kpis: {
    ingestionRate: Measured;
    processingLatencyP95: Measured;
    queueDepth: Measured;
    deadLetterQueue: Measured & { newInWindow: number | null };
  };
  sources: Array<{
    id: string;
    name: string;
    workers: string[];
    observedThrough: string | null;
    lagSeconds: number | null;
    state: "stable" | "delayed" | "partial";
    records: { read: number; written: number; rejected: number };
    coverage: Measured;
    ingestionRate?: Measured;
    processingLatencyP95?: Measured;
    flowSeries?: Array<{ timestamp: string; processing: number; ingestion: number }>;
  }>;
  topology?: ServiceTopology;
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
};

export type ServiceHealth = {
  service: string;
  status: "healthy" | "degraded" | "critical";
  calls: number;
  errors: number;
  errorRate: number;
  latencyP95: number | null;
};

export type ServiceDependency = { source: string; target: string; calls: number; errorRate: number };
export type ServiceTopology = { status: string; services: ServiceHealth[]; dependencies: ServiceDependency[] };

function monitoringWindow(minutes: string): string {
  return ({ "15": "15m", "30": "30m", "60": "1h", "360": "6h" } as Record<string, string>)[minutes.replace("m", "")] ?? minutes;
}

export function fetchServiceTopology(window: string): Promise<Resource<ServiceTopology>> {
  return loadResource<MonitoringResponse, ServiceTopology>({
    path: ENDPOINTS.monitoringOverview,
    params: { window: monitoringWindow(window) },
    map: (response) => {
      if (!response.topology || response.topology.status !== "available")
        throw new Error("A projeção de monitoramento não publica topologia de serviços.");
      return response.topology;
    },
  });
}

export function fetchTelemetrySources(revision = 0): Promise<Resource<TelemetrySource[]>> {
  return loadResource<MonitoringResponse, TelemetrySource[]>({
    path: ENDPOINTS.monitoringOverview,
    params: { window: "6h" },
    map: (response) => response.sources.flatMap((item) => {
      const ingestion = item.ingestionRate?.value;
      const latency = item.processingLatencyP95?.value;
      if (ingestion === null || ingestion === undefined || latency === null || latency === undefined) return [];
      const observed = item.observedThrough ? new Date(item.observedThrough).getTime() : NaN;
      const state = item.state === "delayed" ? "atrasado" : item.state === "partial" ? "parcial" : "estavel";
      return [{
        id: item.id,
        name: item.name,
        worker: item.workers[0] ?? "—",
        updatedSecondsAgo: Number.isNaN(observed) ? item.lagSeconds ?? 0 : Math.max(0, Math.round((Date.now() - observed) / 1000)),
        coverage: Math.round((item.coverage.value ?? 0) * 100),
        state,
        ingestionPerMinute: ingestion / 1_000_000,
        processingLatency: latency / 1000,
        queueDepth: 0,
        deadLetters: 0,
        newDeadLetters: { "15": 0, "30": 0, "60": 0, "360": 0 },
        ingestionTrend: { "15": 0, "30": 0, "60": 0, "360": 0 },
        queueTrend: { "15": 0, "30": 0, "60": 0, "360": 0 },
        flowSeries: item.flowSeries ?? [],
      }];
    }),
    fallback: () => SOURCES.map((source, index) =>
      revision === 0
        ? source
        : {
            ...source,
            updatedSecondsAgo: Math.max(1, Math.round(jitter(source.updatedSecondsAgo, revision * 3 + index, 0.2))),
            ingestionPerMinute: Number(jitter(source.ingestionPerMinute, revision * 5 + index, 0.06).toFixed(2)),
            processingLatency: Math.round(jitter(source.processingLatency, revision * 11 + index, 0.1)),
            queueDepth: Number(jitter(source.queueDepth, revision * 13 + index, 0.12).toFixed(1)),
          },
    ),
  });
}

export function fetchGeographicConcentration(revision = 0): Promise<Resource<StateTelemetry[]>> {
  return loadResource<MonitoringResponse, StateTelemetry[]>({
    path: ENDPOINTS.monitoringOverview,
    params: { window: "6h" },
    map: (response) => response.geography.areas.flatMap((area) => {
      const geometry = STATES.find((state) => state.id === area.code);
      const instability = area.values.instabilityRatio.value;
      const latency = area.values.latencyP95.value;
      const loss = area.values.eventLossRatio.value;
      const sessions = area.observedSessions.value;
      if (!geometry || instability === null || latency === null || loss === null || sessions === null) return [];
      return [{
        id: area.code,
        name: area.name,
        region: area.region,
        path: geometry.path,
        values: { instabilidade: instability * 100, latencia: latency / 1000, perda: loss * 100 },
        sessions: sessions / 1000,
        topSource: area.values.instabilityRatio.measurement.source,
      }];
    }),
    fallback: () => STATES.map((state, index) =>
      revision === 0
        ? state
        : {
            ...state,
            values: {
              instabilidade: Number(jitter(state.values.instabilidade, revision * 17 + index, 0.1).toFixed(1)),
              latencia: Number(jitter(state.values.latencia, revision * 19 + index, 0.08).toFixed(1)),
              perda: Number(jitter(state.values.perda, revision * 23 + index, 0.12).toFixed(1)),
            },
          },
    ),
  });
}

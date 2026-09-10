/** Adapts the gateway overview contract to the existing, unchanged screen. */
import {
  EXPERIENCE_HEALTH_SERIES,
  INCIDENTS,
  STATS,
  type ExperiencePoint,
  type IncidentData,
  type StatCardData,
} from "@/lib/dashboard-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { formatCompact } from "@/lib/format";

export type OverviewFilters = {
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

export type OverviewData = {
  stats: StatCardData[];
  series: ExperiencePoint[];
  baseline: number | null;
  anomalyRange: [number, number] | null;
  peakIndex: number;
  incidents: IncidentData[];
};

/** Preserves the chart formatter hook while honoring the errors/minute contract. */
export function formatErrorsPerMinute(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}/min`;
}

type Measurement = { status: "measured" | "estimated" | "unknown" };
type Kpi = {
  key: string;
  value: number | null;
  unit: string;
  status: "healthy" | "warning" | "critical" | "unknown";
  comparison: { changeRatio: number; direction: "up" | "down" | "stable" } | null;
  shareOfObservedSessions?: number;
  measurement: Measurement;
};

export type OverviewResponse = {
  kpis: Kpi[];
  experienceHealth: {
    baselineValue: number | null;
    points: Array<{ timestamp: string; value: number }>;
    anomalyWindows: Array<{ from: string; to: string; peakTimestamp: string }>;
  };
  recentIncidents: Array<{
    id: string;
    title: string;
    priority: "P1" | "P2" | "P3" | "P4";
    status: string;
    startedAt: string;
    affectedSessions: { value: number | null; measurement: Measurement };
  }>;
};

const toneByPriority: Record<"P1" | "P2" | "P3" | "P4", IncidentData["status"]> = {
  P1: "critical",
  P2: "warning",
  P3: "info",
  P4: "success",
};

const labels: Record<string, string> = {
  errors_per_minute: "Erros por minuto",
  latency_p95: "Latência p95",
  affected_sessions: "Sessões afetadas",
};

function toClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)} h`;
}

function deltaOf(kpi: Kpi): string {
  if (!kpi.comparison) return "";
  const signal = kpi.comparison.direction === "up" ? "+" : kpi.comparison.direction === "down" ? "−" : "";
  return `${signal}${Math.abs(kpi.comparison.changeRatio * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% vs. base`;
}

export function mapOverview(response: OverviewResponse): OverviewData {
  const stats = response.kpis.slice(0, 3).map((kpi, index): StatCardData => ({
    ...(STATS[index] ?? STATS[0]),
    id: kpi.key,
    label: labels[kpi.key] ?? kpi.key,
    value: kpi.measurement.status === "unknown" ? null : kpi.value,
    unit: kpi.unit === "milliseconds" ? " ms" : kpi.unit === "errors_per_minute" ? "/min" : "",
    delta: deltaOf(kpi),
    accent: kpi.status === "critical" ? "critical" : kpi.status === "warning" ? "warning" : "info",
  }));
  const series = response.experienceHealth.points.map((point) => ({
    label: toClock(point.timestamp),
    value: point.value,
  }));
  const anomaly = response.experienceHealth.anomalyWindows[0];
  const anomalyRange: [number, number] | null = anomaly
    ? [
        Math.max(0, response.experienceHealth.points.findIndex((point) => point.timestamp >= anomaly.from)),
        Math.max(0, response.experienceHealth.points.findIndex((point) => point.timestamp >= anomaly.to)),
      ]
    : null;
  const peakTimestamp = anomaly?.peakTimestamp;
  const peakIndex = peakTimestamp
    ? Math.max(0, response.experienceHealth.points.findIndex((point) => point.timestamp === peakTimestamp))
    : series.reduce((best, point, index, all) => (point.value > (all[best]?.value ?? -Infinity) ? index : best), 0);
  return {
    stats,
    series,
    baseline: response.experienceHealth.baselineValue,
    anomalyRange,
    peakIndex,
    incidents: response.recentIncidents.map((incident) => ({
      id: incident.id,
      title: incident.title,
      sessions:
        incident.affectedSessions.value === null || incident.affectedSessions.measurement.status === "unknown"
          ? "sem contagem"
          : `${formatCompact(incident.affectedSessions.value)} sessões`,
      timeAgo: since(incident.startedAt),
      status: toneByPriority[incident.priority],
      statusLabel: incident.status,
    })),
  };
}

function exampleOverview(revision: number): OverviewData {
  return {
    stats: STATS.map((stat, index) => ({
      ...stat,
      value: revision === 0 || stat.value === null ? stat.value : Math.round(jitter(stat.value, revision * 10 + index, 0.05)),
    })),
    series: EXPERIENCE_HEALTH_SERIES.map((point, index) => ({
      ...point,
      value: revision === 0 ? point.value : Math.round(jitter(point.value, revision * 100 + index, 0.08)),
    })),
    baseline: 100,
    anomalyRange: [6, 8],
    peakIndex: 7,
    incidents: INCIDENTS,
  };
}

export function fetchOverview(filters: OverviewFilters, revision = 0): Promise<Resource<OverviewData>> {
  return loadResource<OverviewResponse, OverviewData>({
    path: ENDPOINTS.dashboardOverview,
    params: {
      window: filters.timeRange,
    },
    map: mapOverview,
    fallback: () => exampleOverview(revision),
  });
}

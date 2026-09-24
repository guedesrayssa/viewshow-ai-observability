/** Adapts the public incidents contract without exposing persistence fields. */
import {
  CHART_DATASETS,
  INCIDENTS,
  type ChartBucket,
  type ChartPeriodKey,
  type Incident,
} from "@/app/(painel)/incidentes/incidents-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

export type IncidentsQuery = {
  period: string;
  deviceType: string;
  region: string;
  appVersion: string;
};

type IncidentDto = {
  id: string;
  title: string;
  priority: "P1" | "P2" | "P3" | "P4";
  startedAt: string;
  impact: {
    affectedDevices: { value: number | null; measurement: { status: string } };
  };
  primaryComponent: { id: string; name: string } | null;
  scopeSummary: Array<{ dimension: string; value: string; name: string }>;
};

export type IncidentsResponse = {
  items: IncidentDto[];
  impactSeries: {
    points: Array<{
      timestamp: string;
      total: number;
      byPriority: Record<"P1" | "P2" | "P3" | "P4", number>;
    }>;
  };
};

function optional(value: string): string | undefined {
  return value === "all" ? undefined : value;
}

function windowOf(minutes: string): string {
  return (
    (
      {
        "30": "30m",
        "60": "1h",
        "360": "6h",
        "1440": "24h",
        all: "all",
      } as Record<string, string>
    )[minutes] ?? minutes
  );
}

function scope(item: IncidentDto, dimension: string): string {
  return (
    item.scopeSummary.find((entry) => entry.dimension === dimension)?.name ??
    "—"
  );
}

function toClock(iso: string, short: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hour = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: short ? undefined : "2-digit",
  });
  return short ? `${hour.replace(" h", "")}h` : hour;
}

function toIncident(item: IncidentDto): Incident {
  const devices = item.impact.affectedDevices.value;
  return {
    id: item.id,
    urgency: item.priority,
    title: item.title,
    segment: item.scopeSummary.map((entry) => entry.name).join(" · "),
    devices,
    startedAt: toClock(item.startedAt, false),
    startedMinutesAgo: Math.max(
      0,
      Math.round((Date.now() - new Date(item.startedAt).getTime()) / 60_000),
    ),
    component: item.primaryComponent?.name ?? "—",
    deviceType: scope(item, "deviceType"),
    region: scope(item, "region"),
    appVersion: scope(item, "appVersion"),
  };
}

export function mapIncidents(response: IncidentsResponse): Incident[] {
  return response.items.map(toIncident);
}

export function fetchIncidents(
  query: IncidentsQuery,
  revision = 0,
): Promise<Resource<Incident[]>> {
  return loadResource<IncidentsResponse, Incident[]>({
    path: ENDPOINTS.incidents,
    params: {
      window: windowOf(query.period),
      deviceType: optional(query.deviceType),
      region: optional(query.region),
      appVersion: optional(query.appVersion),
    },
    map: mapIncidents,
    fallback: () =>
      INCIDENTS.map((incident, index) => ({
        ...incident,
        devices:
          revision === 0 || incident.devices === null
            ? incident.devices
            : Math.round(jitter(incident.devices, revision * 20 + index, 0.07)),
      })),
  });
}

export function fetchAffectedDevices(
  period: ChartPeriodKey,
  revision = 0,
): Promise<Resource<ChartBucket[]>> {
  return loadResource<IncidentsResponse, ChartBucket[]>({
    path: ENDPOINTS.incidents,
    params: { window: windowOf(period), chartMetric: "affected_devices" },
    map: (response) =>
      response.impactSeries.points.map((point) => ({
        time: toClock(point.timestamp, period === "1440"),
        value: point.total,
        level:
          point.byPriority.P1 > 0 || point.byPriority.P2 > 0
            ? "critical"
            : "warning",
      })),
    fallback: () =>
      CHART_DATASETS[period].map((bucket, index) => ({
        ...bucket,
        value:
          revision === 0
            ? bucket.value
            : Math.round(jitter(bucket.value, revision * 30 + index, 0.09)),
      })),
  });
}

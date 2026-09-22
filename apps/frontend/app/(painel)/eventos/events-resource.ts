/** Incident-scoped events data from the public gateway contract. */
import {
  CATEGORY_STATS,
  EVENTS,
  VOLUME_DATASETS,
  type CategoryStat,
  type CorrelatedEvent,
  type EventCategory,
  type VolumePeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/eventos/events-data";
import { apiGet, isApiConfigured, jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { ALLOW_EXAMPLE_DATA } from "@/lib/data/mode";

function incidentRequired<T>(): Promise<Resource<T>> {
  const message = "Escolha um incidente antes de consultar eventos.";
  return Promise.resolve({
    source: "indisponivel",
    availability: "unavailable",
    warnings: [{ code: "INCIDENT_REQUIRED", message }],
    fetchedAt: new Date(),
    fallbackReason: message,
  });
}

export type EventsQuery = {
  incidentId: string;
  period: string;
  category: string;
  deviceType: string;
  region: string;
  appVersion: string;
  source: string;
  search?: string;
};

export type EventsData = {
  events: CorrelatedEvent[];
  categories: CategoryStat[];
  facets: { deviceTypes: string[]; regions: string[]; appVersions: string[]; sources: string[] };
  capabilities: {
    individualEvents: { status: "available" | "unavailable"; reason: string | null };
    aggregateMetrics: { status: "available" | "unavailable" };
    filtering: { status: "available" | "partial" | "unavailable"; supportedDimensions: string[] };
  };
  nextCursor: string | null;
};

export type EventItem = {
  id: string;
  timestamp: string;
  category: EventCategory;
  source: { name: string };
  entity: string;
  summary: string;
  quality: { status: string; label?: string };
  dimensions: { deviceType?: string; region?: string; appVersion?: string };
  normalized: { metric: string; value: string; tags: string[] };
  raw: { available: boolean; snippet?: string };
};

type EventsResponse = {
  capabilities: EventsData["capabilities"];
  categoryStats: Array<{ key: EventCategory | "all"; name: string; total: number }>;
  volumeSeries: {
    points: Array<{ timestamp: string; value: number }>;
    anomalyWindows?: Array<{ from: string; to: string }>;
  } | null;
  items: EventItem[];
  facets: EventsData["facets"];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

function optional(value: string): string | undefined {
  return value === "all" ? undefined : value;
}

function windowOf(minutes: string): string {
  return ({ "30": "30m", "60": "1h", "180": "6h", "360": "6h", "1440": "24h", all: "24h" } as Record<string, string>)[minutes] ?? minutes;
}

function toClock(iso: string, seconds = false): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined });
}

function toEvent(item: EventItem): CorrelatedEvent {
  const occurred = new Date(item.timestamp);
  return {
    id: item.id,
    time: toClock(item.timestamp, true),
    minutesAgo: Math.max(0, Math.round((Date.now() - occurred.getTime()) / 60_000)),
    category: item.category,
    source: item.source.name,
    entity: item.entity,
    summary: item.summary,
    quality: {
      label: item.quality.label ?? item.quality.status,
      tone: item.quality.status === "verified" ? "success" : item.quality.status === "unavailable" ? "critical" : "warning",
    },
    deviceType: item.dimensions.deviceType ?? "—",
    region: item.dimensions.region ?? "—",
    appVersion: item.dimensions.appVersion ?? "—",
    detail: {
      metric: item.normalized.metric,
      timestamp: item.timestamp,
      tags: item.normalized.tags,
      value: item.normalized.value,
      rawAvailable: item.raw.available,
      ...(item.raw.snippet ? { rawSnippet: item.raw.snippet } : {}),
    },
  };
}

export function fetchEvents(query: EventsQuery, cursor?: string): Promise<Resource<EventsData>> {
  if (!query.incidentId) return incidentRequired();
  return loadResource<EventsResponse, EventsData>({
    path: ENDPOINTS.events(query.incidentId),
    params: {
      window: windowOf(query.period),
      category: optional(query.category),
      deviceType: optional(query.deviceType),
      region: optional(query.region),
      appVersion: optional(query.appVersion),
      source: optional(query.source),
      search: query.search?.trim() || undefined,
      cursor,
      limit: 50,
    },
    map: (response) => ({
      events: response.items.map(toEvent),
      categories: response.categoryStats.map((item) => ({
        key: item.key,
        label: item.name,
        total: item.total.toLocaleString("pt-BR"),
      })),
      facets: response.facets,
      capabilities: response.capabilities,
      nextCursor: response.page.nextCursor,
    }),
    fallback: () => ({ events: EVENTS, categories: CATEGORY_STATS, facets: { deviceTypes: [], regions: [], appVersions: [], sources: [] }, capabilities: { individualEvents: { status: "available", reason: null }, aggregateMetrics: { status: "available" }, filtering: { status: "available", supportedDimensions: ["category", "deviceType", "region", "appVersion", "source"] } }, nextCursor: null }),
  });
}

export async function fetchEventDetail(incidentId: string, eventId: string): Promise<CorrelatedEvent> {
  if (ALLOW_EXAMPLE_DATA && !isApiConfigured()) {
    const example = EVENTS.find((event) => event.id === eventId);
    if (example) return example;
  }
  const response = await apiGet<EventItem>(ENDPOINTS.event(incidentId, eventId));
  return toEvent(response.data);
}

function axisFor(values: number[]): { axisMax: number; axisTicks: number[] } {
  const top = Math.max(...values, 1);
  const magnitude = 10 ** Math.floor(Math.log10(top));
  const axisMax = Math.ceil(top / magnitude) * magnitude;
  return { axisMax, axisTicks: [0, axisMax / 2, axisMax] };
}

export function fetchEventVolume(
  incidentId: string,
  period: VolumePeriodKey,
  revision = 0,
): Promise<Resource<VolumeSeries>> {
  if (!incidentId) return incidentRequired();
  return loadResource<EventsResponse, VolumeSeries>({
    path: ENDPOINTS.events(incidentId),
    params: { window: windowOf(period) },
    map: (response) => {
      if (!response.volumeSeries) throw new Error("O agregado temporal de eventos não está disponível para este incidente.");
      const cutoff = Date.now() - Number(period) * 60_000;
      const points = response.volumeSeries.points.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
      const values = points.map((point) => point.value);
      const peakIndex = values.reduce((best, value, index, all) => (value > (all[best] ?? -Infinity) ? index : best), 0);
      return {
        times: points.map((point) => toClock(point.timestamp)),
        values,
        peakIndex,
        anomalyRange: null,
        ...axisFor(values),
      };
    },
    fallback: () => {
      const series = VOLUME_DATASETS[period];
      return {
        ...series,
        values: revision === 0 ? series.values : series.values.map((value, index) => Math.round(jitter(value, revision * 60 + index, 0.08))),
      };
    },
  });
}

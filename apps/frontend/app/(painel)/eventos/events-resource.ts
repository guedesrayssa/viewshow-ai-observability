import {
  CATEGORY_LABELS,
  type CategoryStat,
  type CorrelatedEvent,
  type EventCategory,
  type VolumeSeries,
} from "@/app/(painel)/eventos/events-data";
import { loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

export type EventsQuery = {
  incidentId: string;
  period: string;
  search: string;
  category: EventCategory | "all";
  source: string;
  correlation: "all" | "linked" | "unlinked";
  cursor?: string;
};

export type EventsData = {
  queryKey: string;
  events: CorrelatedEvent[];
  categories: CategoryStat[];
  sourceDatasets: string[];
  correlationStatuses: Array<"linked" | "unlinked">;
  hasMore: boolean;
  nextCursor: string | null;
};

export function eventQueryKey(query: Omit<EventsQuery, "cursor">): string {
  return JSON.stringify([
    query.incidentId,
    query.period,
    query.search,
    query.category,
    query.source,
    query.correlation,
  ]);
}

export function mergeEventPages(
  current: CorrelatedEvent[],
  incoming: CorrelatedEvent[],
): CorrelatedEvent[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

export function mergeRequestedEvent(
  events: CorrelatedEvent[],
  requested: CorrelatedEvent | undefined,
): CorrelatedEvent[] {
  if (!requested) return events;
  return mergeEventPages([requested], events);
}

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type EventItem = {
  id: string;
  category: EventCategory;
  source: {
    system: string;
    dataset: string;
    recordId: string;
    canonicalLocator: string;
  };
  occurredAt: string | null;
  dimensions: Record<string, JsonValue>;
  measures: Record<string, JsonValue>;
  correlation: {
    status: "linked" | "unlinked";
    incidentIds: string[];
    links: Array<{ ruleVersion: string; timeDistanceSeconds: number }>;
  };
  quality: {
    status: "measured" | "partial" | "delayed" | "unavailable";
    flags: string[];
    observedThrough: string | null;
  };
  raw: { available: boolean; reason: string };
};

type EventsResponse = {
  categoryStats: Array<{ category: EventCategory; count: number }>;
  volumeSeries: {
    points: Array<{ timestamp: string; count: number }>;
  } | null;
  items: EventItem[];
  facets: {
    categories: EventCategory[];
    sourceDatasets: string[];
    correlationStatuses: Array<"linked" | "unlinked">;
  };
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

function optional(value: string): string | undefined {
  return value === "all" || value.trim() === "" ? undefined : value;
}

function windowOf(minutes: string): string {
  return (
    (
      {
        "30": "30m",
        "60": "1h",
        "180": "6h",
        "360": "6h",
        "1440": "24h",
        all: "all",
      } as Record<string, string>
    )[minutes] ?? minutes
  );
}

function toClock(iso: string | null, seconds = false): string {
  if (iso === null) return "Sem timestamp";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: seconds ? "2-digit" : undefined,
      });
}

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function firstValue(record: Record<string, JsonValue>): string {
  const entry = Object.entries(record)[0];
  return entry ? `${entry[0]}: ${displayValue(entry[1])}` : "Sem medidas";
}

function dimension(
  dimensions: Record<string, JsonValue>,
  ...names: string[]
): string {
  for (const name of names) {
    const value = dimensions[name];
    if (value !== undefined) return displayValue(value);
  }
  return "—";
}

function toEvent(item: EventItem): CorrelatedEvent {
  const occurred = item.occurredAt ? new Date(item.occurredAt) : null;
  return {
    id: item.id,
    time: toClock(item.occurredAt, true),
    minutesAgo:
      occurred && !Number.isNaN(occurred.getTime())
        ? Math.max(0, Math.round((Date.now() - occurred.getTime()) / 60_000))
        : 0,
    category: item.category,
    source: item.source.dataset,
    entity: dimension(
      item.dimensions,
      "entity",
      "source",
      "component",
      "sdeId",
    ),
    summary: firstValue(item.measures),
    quality: {
      label:
        item.correlation.status === "linked"
          ? "Vinculado"
          : item.quality.status === "measured"
            ? "Não correlacionado"
            : item.quality.status,
      tone:
        item.correlation.status === "linked"
          ? "success"
          : item.quality.status === "unavailable"
            ? "critical"
            : "warning",
    },
    deviceType: dimension(item.dimensions, "deviceType", "device_type"),
    region: dimension(item.dimensions, "region", "uf", "pop"),
    appVersion: dimension(item.dimensions, "appVersion", "app_version"),
    detail: {
      metric: item.category,
      timestamp: item.occurredAt ?? "Timestamp ausente na origem",
      tags: Object.entries(item.dimensions).map(
        ([key, value]) => `${key}:${displayValue(value)}`,
      ),
      value: firstValue(item.measures),
      rawAvailable: item.raw.available,
      rawReason: item.raw.reason,
      sourceRecordId: item.source.recordId,
      canonicalLocator: item.source.canonicalLocator,
    },
  };
}

export function fetchEventDetail(
  incidentId: string,
  eventId: string,
): Promise<Resource<CorrelatedEvent>> {
  return loadResource<EventItem, CorrelatedEvent>({
    path: incidentId
      ? ENDPOINTS.event(incidentId, eventId)
      : ENDPOINTS.globalEvent(eventId),
    map: toEvent,
  });
}

function mapEvents(response: EventsResponse): Omit<EventsData, "queryKey"> {
  const total = response.categoryStats.reduce(
    (sum, item) => sum + item.count,
    0,
  );
  return {
    events: response.items.map(toEvent),
    categories: [
      { key: "all", label: "Todos", total: total.toLocaleString("pt-BR") },
      ...response.categoryStats.map((item) => ({
        key: item.category,
        label: CATEGORY_LABELS[item.category],
        total: item.count.toLocaleString("pt-BR"),
      })),
    ],
    sourceDatasets: response.facets.sourceDatasets,
    correlationStatuses: response.facets.correlationStatuses,
    hasMore: response.page.hasMore,
    nextCursor: response.page.nextCursor,
  };
}

export function fetchEvents(query: EventsQuery): Promise<Resource<EventsData>> {
  return loadResource<EventsResponse, EventsData>({
    path: query.incidentId
      ? ENDPOINTS.events(query.incidentId)
      : ENDPOINTS.globalEvents,
    params: {
      window: windowOf(query.period),
      search: optional(query.search),
      category: optional(query.category),
      sourceDataset: optional(query.source),
      correlation: query.incidentId ? undefined : query.correlation,
      cursor: query.cursor,
      limit: 50,
    },
    map: (response) => ({
      ...mapEvents(response),
      queryKey: eventQueryKey(query),
    }),
  });
}

function axisFor(values: number[]): { axisMax: number; axisTicks: number[] } {
  const top = Math.max(...values, 1);
  const magnitude = 10 ** Math.floor(Math.log10(top));
  const axisMax = Math.ceil(top / magnitude) * magnitude;
  return { axisMax, axisTicks: [0, axisMax / 2, axisMax] };
}

export function fetchEventVolume(
  incidentId: string,
  period: string,
  revision = 0,
): Promise<Resource<VolumeSeries>> {
  void revision;
  return loadResource<EventsResponse, VolumeSeries>({
    path: incidentId ? ENDPOINTS.events(incidentId) : ENDPOINTS.globalEvents,
    params: { window: windowOf(period), limit: 1 },
    map: (response) => {
      if (!response.volumeSeries)
        throw new Error(
          "O agregado temporal de eventos ainda não está disponível.",
        );
      const values = response.volumeSeries.points.map((point) => point.count);
      const peakIndex = values.reduce(
        (best, value, index, all) =>
          value > (all[best] ?? -Infinity) ? index : best,
        0,
      );
      return {
        times: response.volumeSeries.points.map((point) =>
          toClock(point.timestamp),
        ),
        values,
        peakIndex,
        anomalyRange: null,
        ...axisFor(values),
      };
    },
  });
}

import {
  CATEGORY_LABELS,
  PERIOD_WINDOWS,
  type CategoryStat,
  type CorrelatedEvent,
  type EventCategory,
  type EventSort,
  type PeriodKey,
  type VolumeSeries,
} from "@/app/(painel)/incidentes/_eventos/events-data";
import { loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { formatDateTime, minutesSince } from "@/lib/format";

export type EventsQuery = {
  incidentId: string;
  period: string;
  search: string;
  category: EventCategory | "all";
  source: string;
  correlation: "all" | "linked" | "unlinked";
  sort?: EventSort;
  /**
   * Intervalo explícito. Quando presente, vai à API como `from`/`to` e
   * substitui a janela relativa de `period`.
   */
  range?: { from: string; to: string } | null;
  cursor?: string;
};

export type EventsData = {
  queryKey: string;
  events: CorrelatedEvent[];
  /** Total de eventos no recorte (soma das categorias), para a contagem da lista. */
  total: number;
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
    query.sort ?? "recent",
    query.range?.from ?? null,
    query.range?.to ?? null,
  ]);
}

/**
 * Recorte temporal da leitura: o intervalo explícito, quando houver, ou a
 * janela relativa do período. A API usa `from`/`to` no lugar de `window`
 * quando recebe os dois.
 */
function timeParams(query: Pick<EventsQuery, "period" | "range">) {
  if (query.range) return { from: query.range.from, to: query.range.to };
  // "Mais de 24 horas" não tem janela na API: vai como intervalo, do limite
  // que a API aceita (31 dias) até 24 horas atrás.
  if (query.period === "older") {
    const now = Date.now();
    return {
      from: new Date(now - OLDER_SPAN_MS).toISOString(),
      to: new Date(now - DAY_MS).toISOString(),
    };
  }
  return { window: windowOf(query.period) };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Um pouco menos que os 31 dias que a API aceita num intervalo explícito. */
const OLDER_SPAN_MS = 30 * DAY_MS;

/** Filtros da leitura, os mesmos para a lista e para o gráfico de volume. */
function filterParams(query: Omit<EventsQuery, "cursor">) {
  return {
    ...timeParams(query),
    search: optional(query.search),
    category: optional(query.category),
    sourceDataset: optional(query.source),
    correlation: query.incidentId ? undefined : query.correlation,
  };
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

/**
 * Janela da API para o período da tela. Antes, "últimas 3 horas" do gráfico
 * pedia `6h` à API e o gráfico mostrava o dobro do que dizia.
 */
function windowOf(period: string): string {
  return PERIOD_WINDOWS[period as PeriodKey] ?? period;
}

function toClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Medidas do evento em uma linha. Mostrar só a primeira deixava linhas
 * diferentes com o mesmo resumo e escondia qual métrica o valor media.
 */
function measuresSummary(record: Record<string, JsonValue>, limit = 3): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "Sem medidas";
  const shown = entries
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${displayValue(value)}`);
  const rest = entries.length - limit;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
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
  return {
    id: item.id,
    // Com a data: em "Todo o período" ou 24 horas, a hora sozinha não diz o dia.
    time: item.occurredAt
      ? formatDateTime(item.occurredAt, { seconds: true })
      : "Sem timestamp",
    minutesAgo: minutesSince(item.occurredAt),
    category: item.category,
    source: item.source.dataset,
    entity: dimension(
      item.dimensions,
      "entity",
      "source",
      "component",
      "sdeId",
    ),
    summary: measuresSummary(item.measures),
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
    incidentIds: item.correlation.incidentIds ?? [],
    detail: {
      metric: item.category,
      timestamp: item.occurredAt ?? "Timestamp ausente na origem",
      tags: Object.entries(item.dimensions).map(
        ([key, value]) => `${key}:${displayValue(value)}`,
      ),
      value: measuresSummary(item.measures, Number.POSITIVE_INFINITY),
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
    total,
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
      ...filterParams(query),
      sort: query.sort && query.sort !== "recent" ? query.sort : undefined,
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

/**
 * Série de volume do mesmo recorte da lista. Antes o gráfico só recebia o
 * período e ignorava busca, tipo, fonte e vínculo: a tabela e o gráfico
 * contavam coisas diferentes.
 */
export function fetchEventVolume(
  query: Omit<EventsQuery, "cursor">,
  revision = 0,
): Promise<Resource<VolumeSeries>> {
  void revision;
  return loadResource<EventsResponse, VolumeSeries>({
    path: query.incidentId ? ENDPOINTS.events(query.incidentId) : ENDPOINTS.globalEvents,
    params: { ...filterParams(query), limit: 1 },
    map: toVolume,
  });
}

function toVolume(response: EventsResponse): VolumeSeries {
  if (!response.volumeSeries)
    throw new Error("O agregado temporal de eventos ainda não está disponível.");
  const values = response.volumeSeries.points.map((point) => point.count);
  const peakIndex = values.reduce(
    (best, value, index, all) => (value > (all[best] ?? -Infinity) ? index : best),
    0,
  );
  return {
    times: response.volumeSeries.points.map((point) => toClock(point.timestamp)),
    values,
    peakIndex,
    anomalyRange: null,
    ...axisFor(values),
  };
}

/** Adapts the public incidents contract without exposing persistence fields. */
import {
  CHART_DATASETS,
  INCIDENTS,
  type ChartBucket,
  type ChartPeriodKey,
  type Incident,
  type PeriodKey,
  type SortKey,
  withinPeriod,
} from "@/app/(painel)/incidentes/incidents-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { formatDateTime, minutesSince } from "@/lib/format";
import { incidentCode, incidentHeadline } from "@/lib/incidents/labels";

/** Maior página que a API de incidentes entrega por leitura. */
export const INCIDENTS_PAGE_LIMIT = 100;

export type IncidentsQuery = {
  period: PeriodKey | string;
  priority?: string;
  status?: string;
  sort?: SortKey;
  /**
   * Dimensões que a API de incidentes ainda não recorta (responde 422
   * `UNSUPPORTED_FILTER_COMBINATION`). Só vão na leitura quando diferentes de
   * "all"; a tela deixa de oferecê-las enquanto `capabilities` não as listar.
   */
  deviceType?: string;
  region?: string;
  appVersion?: string;
};

type IncidentDto = {
  id: string;
  number?: string | null;
  title: string;
  priority: "P1" | "P2" | "P3" | "P4";
  status?: string;
  startedAt: string;
  impact: {
    affectedDevices: { value: number | null; measurement: { status: string } };
  };
  primaryComponent: { id: string; name: string } | null;
  scopeSummary: Array<{ dimension: string; value: string; name: string }>;
};

export type IncidentsResponse = {
  capabilities?: {
    filtering?: { supportedDimensions?: string[] };
  };
  items: IncidentDto[];
  impactSeries: {
    points: Array<{
      timestamp: string;
      total: number;
      byPriority: Record<"P1" | "P2" | "P3" | "P4", number>;
    }>;
  };
  page?: { limit: number; hasMore: boolean; nextCursor: string | null };
};

export type IncidentsList = {
  items: Incident[];
  /** A origem tem mais incidentes no recorte do que os lidos. */
  hasMore: boolean;
  /** Quantos incidentes a leitura pediu. */
  limit: number;
  /** Dimensões que a origem aceita como filtro nesta leitura. */
  supportedDimensions: string[];
};

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "all" || value.trim() === ""
    ? undefined
    : value;
}

function windowOf(minutes: string): string {
  return (
    (
      {
        "30": "30m",
        "60": "1h",
        "360": "6h",
        "1440": "24h",
        // "Mais de 24 horas" não tem janela na API (e um `from`/`to` só cobre
        // 31 dias): lê tudo e recorta na tela.
        older: "all",
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
  return {
    id: item.id,
    code: incidentCode(item),
    urgency: item.priority,
    title: incidentHeadline(item),
    status: item.status ?? "",
    segment: item.scopeSummary.map((entry) => entry.name).join(" · "),
    devices: item.impact.affectedDevices.value,
    startedAt: formatDateTime(item.startedAt),
    startedAtIso: item.startedAt,
    startedMinutesAgo: minutesSince(item.startedAt),
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
): Promise<Resource<IncidentsList>> {
  return loadResource<IncidentsResponse, IncidentsList>({
    path: ENDPOINTS.incidents,
    params: {
      // O período vai à API, que recorta por `startedAt` antes de aplicar o
      // limite. Com `window=all` em todos os casos, um recorte de 24 horas
      // com mais de 100 incidentes no total perdia itens sem necessidade.
      window: windowOf(query.period),
      priority: optional(query.priority),
      status: optional(query.status),
      // A API ordena por prioridade ou recência; "mais dispositivos" é
      // ordenado na tela, porque a origem ainda não mede impacto.
      sort: query.sort === "urgency" ? "priority" : undefined,
      deviceType: optional(query.deviceType),
      region: optional(query.region),
      appVersion: optional(query.appVersion),
      // Sem `limit`, a API devolvia só os 20 primeiros, sem aviso na tela.
      limit: INCIDENTS_PAGE_LIMIT,
    },
    map: (response) => ({
      // O recorte na tela continua: é ele que faz "Mais de 24 horas", e
      // protege a lista se a API publicada ignorar a janela.
      items: mapIncidents(response).filter((incident) =>
        withinPeriod(incident.startedMinutesAgo, query.period),
      ),
      hasMore: response.page?.hasMore ?? false,
      limit: response.page?.limit ?? INCIDENTS_PAGE_LIMIT,
      supportedDimensions:
        response.capabilities?.filtering?.supportedDimensions ?? [],
    }),
    fallback: () => ({
      items: INCIDENTS.map((incident, index) => ({
        ...incident,
        devices:
          revision === 0 || incident.devices === null
            ? incident.devices
            : Math.round(jitter(incident.devices, revision * 20 + index, 0.07)),
      })),
      hasMore: false,
      limit: INCIDENTS_PAGE_LIMIT,
      supportedDimensions: ["priority", "status"],
    }),
  });
}

export function fetchAffectedDevices(
  period: ChartPeriodKey | PeriodKey | string,
  revision = 0,
): Promise<Resource<ChartBucket[]>> {
  return loadResource<IncidentsResponse, ChartBucket[]>({
    path: ENDPOINTS.incidents,
    params: {
      window: windowOf(period),
      chartMetric: "affected_devices",
      limit: 1,
    },
    map: (response) =>
      response.impactSeries.points.map((point) => ({
        time: toClock(point.timestamp, period === "1440" || period === "all"),
        value: point.total,
        level:
          point.byPriority.P1 > 0 || point.byPriority.P2 > 0
            ? "critical"
            : "warning",
      })),
    fallback: () =>
      (CHART_DATASETS[period as ChartPeriodKey] ?? CHART_DATASETS["1440"]).map(
        (bucket, index) => ({
          ...bucket,
          value:
            revision === 0
              ? bucket.value
              : Math.round(jitter(bucket.value, revision * 30 + index, 0.09)),
        }),
      ),
  });
}

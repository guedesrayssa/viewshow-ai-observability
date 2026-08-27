/**
 * @file overview-resource.ts
 * Leitura dos dados da Visão Geral.
 *
 * A tela junta duas APIs porque nenhuma delas responde sozinha o que ela
 * pergunta: a medição bruta — erros por minuto, tempo de início, sessões
 * afetadas e a série no tempo — vem da API de telemetria; a lista de
 * incidentes recentes vem da API operacional, que é a única que sabe o que é
 * um incidente.
 *
 * A telemetria é a dependência dura: sem ela não há Visão Geral. A operacional
 * é secundária — se ela não responde, a lista de incidentes fica vazia com um
 * aviso, e o resto da tela continua sendo medição de verdade.
 */

import {
  apiGet,
  composeResource,
  jitter,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { WARNINGS } from "@/lib/data/warnings";
import {
  EXPERIENCE_HEALTH_SERIES,
  INCIDENTS,
  STATS,
  type ExperiencePoint,
  type IncidentData,
  type StatCardData,
} from "@/lib/dashboard-data";
import { formatCompact } from "@/lib/format";

/** Recorte pedido pela barra de filtros. */
export type OverviewFilters = {
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

/** Tudo o que a Visão Geral desenha em uma leitura. */
export type OverviewData = {
  stats: StatCardData[];
  series: ExperiencePoint[];
  /** `null` enquanto não houver linha de base publicada. */
  baseline: number | null;
  /** `null` enquanto não houver detecção de anomalia na origem. */
  anomalyRange: [number, number] | null;
  peakIndex: number;
  incidents: IncidentData[];
};

/* -------------------------------------------------------------------------
 * Formatos das respostas, como as APIs os publicam hoje.
 *
 * Estão escritos aqui, ao lado da conversão, porque é isto que muda quando o
 * contrato do dashboard for implementado: os tipos de domínio acima seguem
 * iguais.
 * ---------------------------------------------------------------------- */

/** `GET /v1/analytics/realtime/overview` na API de telemetria. */
export type RealtimeOverviewResponse = {
  ccu: number;
  active_sessions: number;
  events: { total: number; per_minute: number };
  errors: {
    total: number;
    fatal: number;
    per_minute: number;
    rate: number | null;
  };
  generated_at: string;
};

/** Bloco de métricas de QoE, repetido no agregado e em cada ponto da série. */
export type QoeMetricsBlock = {
  events: number;
  sessions: number;
  playback_hours: number;
  startup_time_ms: {
    samples: number;
    p50: number | null;
    p95: number | null;
    average: number | null;
  };
  rebuffer: { rate: number | null; count: number };
  average_bitrate_kbps: number | null;
};

/** `GET /v1/analytics/qoe/metrics`. */
export type QoeMetricsResponse = { metrics: QoeMetricsBlock };

/** `GET /v1/analytics/qoe/timeseries`. */
export type QoeTimeseriesResponse = {
  interval_seconds: number;
  points: { start: string; end: string; metrics: QoeMetricsBlock }[];
};

/** `GET /v1/analytics/errors/summary`. */
export type ErrorsSummaryResponse = {
  summary: {
    total_errors: number;
    fatal_errors: number;
    unique_error_codes: number;
    affected_sessions: number;
    total_sessions: number;
    error_rate: number | null;
    crash_free_rate: number | null;
  };
};

/** Incidente como a API operacional o devolve hoje. */
export type IncidentResponse = {
  id: string;
  title: string;
  sessions?: string;
  timeAgo?: string;
  status?: string;
  statusLabel?: string;
  devices?: number;
  startedMinutesAgo?: number;
};

/** `GET /api/v1/incidents`. */
export type IncidentsResponse = { incidents: IncidentResponse[] };

/**
 * Remove repetições do mesmo incidente, ficando com a ocorrência mais recente.
 * Execuções distintas do seed gravaram o mesmo `id` em baldes de horas
 * diferentes, e a rota devolve todos.
 */
function dedupeById(incidents: IncidentResponse[]): IncidentResponse[] {
  const byId = new Map<string, IncidentResponse>();

  for (const incident of incidents) {
    const current = byId.get(incident.id);
    if (
      !current ||
      (incident.startedMinutesAgo ?? Infinity) <
        (current.startedMinutesAgo ?? Infinity)
    ) {
      byId.set(incident.id, incident);
    }
  }

  return [...byId.values()];
}

/** Tons de incidente que a Visão Geral sabe desenhar. */
const INCIDENT_STATUSES = new Set(["critical", "warning", "success", "info"]);

/** Rótulo do eixo a partir do início do intervalo, no fuso de quem lê. */
function toClockLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Escreve a taxa de travamento como percentual, com duas casas. */
export function formatRebufferRate(value: number): string {
  return `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

/** Índice do maior ponto da série. Zero quando a série está vazia. */
function peakOf(series: ExperiencePoint[]): number {
  return series.reduce(
    (best, point, index, all) => (point.value > all[best].value ? index : best),
    0,
  );
}

/**
 * Projeta o incidente da API no que o cartão da Visão Geral desenha.
 *
 * A rota devolve o item como ele está guardado, com as chaves físicas da
 * tabela junto. Copiar campo a campo é o que impede `pk`, `sk` e `ttl` de
 * chegarem à tela.
 */
function toIncidentCard(incident: IncidentResponse): IncidentData {
  const status = INCIDENT_STATUSES.has(incident.status ?? "")
    ? (incident.status as IncidentData["status"])
    : "info";

  return {
    id: incident.id,
    title: incident.title,
    sessions:
      incident.sessions ??
      (incident.devices === undefined
        ? "sem contagem"
        : `${formatCompact(incident.devices)} dispositivos`),
    timeAgo:
      incident.timeAgo ??
      (incident.startedMinutesAgo === undefined
        ? ""
        : `há ${incident.startedMinutesAgo} min`),
    status,
    statusLabel: incident.statusLabel ?? "Ativo",
  };
}

/** Conjunto de exemplo, com leve variação a cada atualização. */
function exampleOverview(revision: number): OverviewData {
  return {
    stats: STATS.map((stat, index) => ({
      ...stat,
      value:
        revision === 0 || stat.value === null
          ? stat.value
          : Math.round(jitter(stat.value, revision * 10 + index, 0.05)),
    })),
    series: EXPERIENCE_HEALTH_SERIES.map((point, index) => ({
      ...point,
      value:
        revision === 0
          ? point.value
          : Math.round(jitter(point.value, revision * 100 + index, 0.08)),
    })),
    baseline: 100,
    anomalyRange: [6, 8],
    peakIndex: 7,
    incidents: INCIDENTS,
  };
}

/**
 * Lê o estado do ecossistema para o recorte selecionado.
 *
 * @param filters - Recorte da barra de filtros.
 * @param revision - Número da leitura, usado só pelo conjunto de exemplo.
 *
 * @example
 * const overview = useResource((revision) => fetchOverview(filters, revision), [filters]);
 */
export function fetchOverview(
  filters: OverviewFilters,
  revision = 0,
): Promise<Resource<OverviewData>> {
  const window = filters.timeRange;

  return composeResource<OverviewData>({
    targets: ["telemetria"],
    // A linha de base e a detecção de anomalia não existem em nenhuma das duas
    // APIs. Declarar isso é o que permite ao gráfico não desenhar uma
    // referência que ninguém publicou.
    warnings: [WARNINGS.semLinhaDeBase],
    read: async (warn) => {
      const [realtime, qoe, errors, timeseries] = await Promise.all([
        apiGet<RealtimeOverviewResponse>(
          "telemetria",
          ENDPOINTS.telemetria.realtimeOverview,
          { window },
        ),
        apiGet<QoeMetricsResponse>("telemetria", ENDPOINTS.telemetria.qoeMetrics, {
          window,
        }),
        apiGet<ErrorsSummaryResponse>(
          "telemetria",
          ENDPOINTS.telemetria.errorsSummary,
          { window },
        ),
        apiGet<QoeTimeseriesResponse>(
          "telemetria",
          ENDPOINTS.telemetria.qoeTimeseries,
          { window },
        ),
      ]);

      // A lista de incidentes é secundária: a Visão Geral continua respondendo
      // sem ela, só sem a coluna da direita. A janela é própria, de 24 horas —
      // "incidentes recentes" é a fila do plantão, e ela não deve esvaziar
      // porque a telemetria está recortada em meia hora.
      let incidents: IncidentData[] = [];
      try {
        const response = await apiGet<IncidentsResponse>(
          "operacional",
          ENDPOINTS.operacional.incidents,
          { window: "1440" },
        );
        incidents = dedupeById(response.incidents)
          .slice(0, 4)
          .map(toIncidentCard);
      } catch {
        warn(WARNINGS.operacionalIndisponivel);
      }

      const series: ExperiencePoint[] = timeseries.points.map((point) => ({
        label: toClockLabel(point.start),
        value: point.metrics.rebuffer.rate ?? 0,
      }));

      if (qoe.metrics.startup_time_ms.p95 === null) warn(WARNINGS.metricaSemFonte);

      return {
        stats: [
          {
            ...STATS[0],
            label: "Erros por minuto",
            value: realtime.errors.per_minute,
            format: "integer",
            unit: "/min",
            delta: `${realtime.errors.total} na janela`,
          },
          {
            ...STATS[1],
            // A grandeza medida é o tempo até a reprodução começar, não a
            // latência de rede: o rótulo antigo prometia outra coisa.
            label: "Tempo de início (p95)",
            value: qoe.metrics.startup_time_ms.p95,
            format: "integer",
            unit: " ms",
            delta: `${qoe.metrics.startup_time_ms.samples} amostras`,
          },
          {
            ...STATS[2],
            label: "Sessões afetadas",
            value: errors.summary.affected_sessions,
            format: "compact",
            delta: `de ${formatCompact(errors.summary.total_sessions)} observadas`,
          },
          {
            id: "active-sessions",
            label: "Sessões ativas",
            value: realtime.active_sessions,
            format: "compact",
            unit: "",
            // O CCU conta só quem mandou heartbeat nos últimos 2 minutos; as
            // sessões ativas contam a janela toda. Os dois juntos dizem o
            // tamanho do agora e o tamanho do recorte.
            delta: `${formatCompact(realtime.ccu)} simultâneas agora`,
            accent: "info",
            deltaTone: "neutral",
          },
        ],
        series,
        baseline: null,
        anomalyRange: null,
        peakIndex: peakOf(series),
        incidents,
      };
    },
    fallback: () => exampleOverview(revision),
  });
}

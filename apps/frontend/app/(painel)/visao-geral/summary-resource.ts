/**
 * @file summary-resource.ts
 * Resumo operacional da Visão Geral, derivado de `GET /api/v1/incidents`.
 *
 * Esta é a leitura que **não depende da telemetria**: os três indicadores do
 * topo (sessões afetadas, incidentes ativos, incidentes críticos) e a lista de
 * incidentes recentes saem da rota de incidentes, que lê a tabela operacional
 * direto — sem esperar a projeção de QoE da ingestão. A série de "saúde da
 * experiência" continua em `overview-resource.ts`, sobre
 * `/api/v1/dashboard/overview`, porque medição de QoE é telemetria bruta.
 *
 * Separar as duas leituras é o que permite a tela mostrar número real no topo
 * mesmo quando a telemetria não está publicada — em vez de cair inteira para o
 * conjunto de exemplo.
 */

import { loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import {
  type IncidentData,
  type IncidentStatus,
  type StatAccent,
  type StatCardData,
  type StatFormat,
} from "@/lib/dashboard-data";
import { formatCompact } from "@/lib/format";

/** Incidente como `GET /api/v1/incidents` o devolve (subconjunto usado aqui). */
type GatewayIncident = {
  id: string;
  title: string;
  priority: "P1" | "P2" | "P3" | "P4";
  status: "detected" | "investigating" | "confirmed" | "resolved" | "closed";
  startedAt: string;
  impact: {
    affectedSessions: {
      value: number | null;
      measurement: { status: "measured" | "estimated" | "unknown" };
    };
  };
};

/** `GET /api/v1/incidents` — só os campos que o resumo consome. */
export type IncidentsResponse = {
  items: GatewayIncident[];
};

/** O que a Visão Geral desenha a partir do resumo operacional. */
export type SummaryData = {
  stats: StatCardData[];
  incidents: IncidentData[];
};

const ACTIVE_STATUSES = new Set(["detected", "investigating", "confirmed"]);

/** Tom do cartão de incidente a partir da prioridade, como na Visão Geral. */
const TONE_BY_PRIORITY: Record<"P1" | "P2" | "P3" | "P4", IncidentStatus> = {
  P1: "critical",
  P2: "warning",
  P3: "info",
  P4: "success",
};

const STAT_ACCENTS = new Set<StatAccent>(["critical", "warning", "info"]);
const STAT_FORMATS = new Set<StatFormat>(["integer", "compact"]);

/**
 * Converte o `value` do indicador para número, tolerando a resposta anterior.
 *
 * Enquanto o deploy do back não alcança o do front, o número pode chegar
 * formatado em pt-BR ("12.400"). Sem normalizar, `Math.round("12.400")` é 12 —
 * o cartão mostraria 12 no lugar de 12.400. Como os três indicadores são
 * sempre inteiros (contagens e total de sessões), remover os pontos de milhar
 * e trocar a vírgula decimal por ponto basta. Passada a transição, `value` já
 * é `number` e a função só o repassa.
 *
 * O que não dá para ler — string vazia, só espaço, texto, `NaN`, ou um tipo
 * inesperado — vira `null`, nunca `0`: `Number("")` é `0`, e um zero afirmaria
 * que a grandeza foi medida e deu zero. Com `null`, o cartão desenha um
 * travessão.
 */
export function toNumericValue(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  if (normalized === "") {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function statCard(
  id: string,
  label: string,
  value: number | null,
  format: StatFormat,
  accent: StatAccent,
): StatCardData {
  return {
    id,
    label,
    value,
    format: STAT_FORMATS.has(format) ? format : "integer",
    delta: "",
    accent: STAT_ACCENTS.has(accent) ? accent : "info",
    deltaTone: "neutral",
  };
}

function since(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (Number.isNaN(minutes)) return "";
  return minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)} h`;
}

function toIncidentCard(incident: GatewayIncident): IncidentData {
  const sessions = incident.impact.affectedSessions;
  return {
    id: incident.id,
    title: incident.title,
    sessions:
      sessions.value === null || sessions.measurement.status === "unknown"
        ? "sem contagem"
        : `${formatCompact(sessions.value)} sessões`,
    timeAgo: since(incident.startedAt),
    status: TONE_BY_PRIORITY[incident.priority],
    statusLabel: incident.status,
  };
}

/**
 * Projeta a resposta de `/api/v1/incidents` no resumo operacional.
 *
 * A rota agrega contagens, não mede contra uma linha de base: `delta` fica
 * vazio e o tom vem da severidade, sem inventar uma comparação.
 */
export function mapSummary(response: IncidentsResponse): SummaryData {
  const active = response.items.filter((incident) =>
    ACTIVE_STATUSES.has(incident.status),
  );
  const affectedSessions = active.reduce((total, incident) => {
    const measured = incident.impact.affectedSessions;
    return measured.value === null || measured.measurement.status === "unknown"
      ? total
      : total + measured.value;
  }, 0);
  const criticalCount = active.filter(
    (incident) => incident.priority === "P1",
  ).length;

  const stats: StatCardData[] = [
    statCard(
      "affected-sessions",
      "Sessões afetadas",
      affectedSessions,
      "compact",
      "info",
    ),
    statCard(
      "active-incidents",
      "Incidentes ativos",
      active.length,
      "integer",
      active.length > 0 ? "warning" : "info",
    ),
    statCard(
      "critical-incidents",
      "Incidentes críticos",
      criticalCount,
      "integer",
      criticalCount > 0 ? "critical" : "info",
    ),
  ];

  const incidents = [...response.items]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 6)
    .map(toIncidentCard);

  return { stats, incidents };
}

/** Conjunto de exemplo do resumo, usado só onde o dado de exemplo é permitido. */
function exampleSummary(): SummaryData {
  return {
    stats: [
      statCard("affected-sessions", "Sessões afetadas", 12400, "compact", "info"),
      statCard("active-incidents", "Incidentes ativos", 3, "integer", "warning"),
      statCard(
        "critical-incidents",
        "Incidentes críticos",
        1,
        "integer",
        "critical",
      ),
    ],
    incidents: [
      {
        id: "exemplo-tvs-lg",
        title: "Falhas de reprodução em TVs LG",
        sessions: "12,4 mil sessões",
        timeAgo: "há 18 min",
        status: "critical",
        statusLabel: "confirmed",
      },
      {
        id: "exemplo-cdn-nordeste",
        title: "Timeout de CDN no Nordeste",
        sessions: "2,1 mil sessões",
        timeAgo: "há 31 min",
        status: "warning",
        statusLabel: "investigating",
      },
      {
        id: "exemplo-drm",
        title: "DRM expirado",
        sessions: "824 sessões",
        timeAgo: "há 42 min",
        status: "info",
        statusLabel: "detected",
      },
    ],
  };
}

/**
 * Lê o resumo operacional da Visão Geral.
 *
 * @param revision - Número da leitura. Aqui não altera nada: o resumo não tem
 * conjunto de exemplo que varie entre atualizações, mas a assinatura segue a
 * das outras leituras da tela.
 *
 * @example
 * const summary = useResource((revision) => fetchSummary(revision), []);
 */
export function fetchSummary(revision = 0): Promise<Resource<SummaryData>> {
  void revision;

  return loadResource<IncidentsResponse, SummaryData>({
    path: ENDPOINTS.incidents,
    params: { window: "24h" },
    map: mapSummary,
    fallback: exampleSummary,
  });
}

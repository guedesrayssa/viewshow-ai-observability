/**
 * @file summary-resource.ts
 * Resumo operacional da Visão Geral, vindo de `/api/v1/dashboard/summary`.
 *
 * Esta é a leitura que **não depende da telemetria**: os três indicadores do
 * topo (sessões afetadas, incidentes ativos, incidentes críticos) e a lista de
 * incidentes recentes saem da API operacional, que agrega o que já está na
 * tabela de incidentes. A série de "saúde da experiência" continua em
 * `overview-resource.ts`, porque medição de QoE é telemetria bruta e não tem
 * como ser derivada daqui.
 *
 * Separar as duas leituras é o que permite a tela mostrar número real no topo
 * mesmo quando a telemetria não está publicada — em vez de cair inteira para o
 * conjunto de exemplo.
 */

import { apiGet, composeResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import {
  type IncidentData,
  type StatAccent,
  type StatCardData,
  type StatFormat,
} from "@/lib/dashboard-data";
import {
  dedupeById,
  toIncidentCard,
  type IncidentResponse,
} from "@/app/(painel)/visao-geral/incident-mapping";

/** Um indicador como `/api/v1/dashboard/summary` o publica. */
export type SummaryStatResponse = {
  id: string;
  label: string;
  value: number;
  format: StatFormat;
  accent: StatAccent;
};

/** `GET /api/v1/dashboard/summary`. */
export type DashboardSummaryResponse = {
  stats: SummaryStatResponse[];
  recentIncidents: IncidentResponse[];
};

/** O que a Visão Geral desenha a partir do resumo operacional. */
export type SummaryData = {
  stats: StatCardData[];
  incidents: IncidentData[];
};

const STAT_ACCENTS = new Set<StatAccent>(["critical", "warning", "info"]);
const STAT_FORMATS = new Set<StatFormat>(["integer", "compact"]);

/**
 * Completa o indicador da API com os campos que só a tela usa.
 *
 * A rota resume contagens, não mede contra uma linha de base: `delta` fica
 * vazio e o tom é neutro, em vez de inventar uma comparação.
 */
function toStatCard(stat: SummaryStatResponse): StatCardData {
  return {
    id: stat.id,
    label: stat.label,
    value: stat.value,
    format: STAT_FORMATS.has(stat.format) ? stat.format : "integer",
    delta: "",
    accent: STAT_ACCENTS.has(stat.accent) ? stat.accent : "info",
    deltaTone: "neutral",
  };
}

/** Conjunto de exemplo do resumo, usado só onde o dado de exemplo é permitido. */
function exampleSummary(): SummaryData {
  return {
    stats: [
      {
        id: "affected-sessions",
        label: "Sessões afetadas",
        value: 12400,
        format: "compact",
        delta: "",
        accent: "info",
        deltaTone: "neutral",
      },
      {
        id: "active-incidents",
        label: "Incidentes ativos",
        value: 3,
        format: "integer",
        delta: "",
        accent: "warning",
        deltaTone: "neutral",
      },
      {
        id: "critical-incidents",
        label: "Incidentes críticos",
        value: 1,
        format: "integer",
        delta: "",
        accent: "critical",
        deltaTone: "neutral",
      },
    ],
    incidents: [
      {
        id: "exemplo-tvs-lg",
        title: "Falhas de reprodução em TVs LG",
        sessions: "12,4 mil dispositivos",
        timeAgo: "há 18 min",
        status: "critical",
        statusLabel: "Crítico",
      },
      {
        id: "exemplo-cdn-nordeste",
        title: "Timeout de CDN no Nordeste",
        sessions: "2,1 mil dispositivos",
        timeAgo: "há 31 min",
        status: "warning",
        statusLabel: "Atenção",
      },
      {
        id: "exemplo-drm",
        title: "DRM expirado",
        sessions: "824 dispositivos",
        timeAgo: "há 42 min",
        status: "info",
        statusLabel: "Ativo",
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

  return composeResource<SummaryData>({
    targets: ["operacional"],
    read: async () => {
      const response = await apiGet<DashboardSummaryResponse>(
        "operacional",
        ENDPOINTS.operacional.dashboardSummary,
      );

      return {
        stats: response.stats.map(toStatCard),
        incidents: dedupeById(response.recentIncidents).map(toIncidentCard),
      };
    },
    fallback: exampleSummary,
  });
}

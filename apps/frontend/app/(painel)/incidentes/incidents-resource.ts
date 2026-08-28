/**
 * @file incidents-resource.ts
 * Leitura dos dados da tela de Incidentes.
 *
 * As duas leituras vêm da API operacional, a única que sabe o que é um
 * incidente. A lista chega já recortada pela janela e pelas dimensões; o
 * gráfico por horário é montado a partir da mesma listagem, agrupando os
 * dispositivos pela hora em que cada incidente começou.
 *
 * Agrupar não é inventar: o valor de cada barra é a soma de um campo que a
 * própria resposta traz. O que mudou foi o rótulo — o gráfico diz "dispositivos
 * de incidentes iniciados por horário", que é o que ele de fato mostra, e não
 * uma série contínua de dispositivos afetados, que exigiria uma medição por
 * intervalo que nenhuma das duas APIs publica.
 */

import {
  CHART_DATASETS,
  INCIDENTS,
  type ChartBucket,
  type ChartLevel,
  type ChartPeriodKey,
  type Incident,
  type Urgency,
} from "@/app/(painel)/incidentes/incidents-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

/** Recorte pedido pela barra de filtros da tela. */
export type IncidentsQuery = {
  period: string;
  deviceType: string;
  region: string;
  appVersion: string;
};

/**
 * Incidente como a API operacional o devolve hoje.
 *
 * A rota entrega o item como ele está guardado, então a resposta também carrega
 * `pk`, `sk`, `trace_id` e `ttl`. Eles não entram neste tipo de propósito: o que
 * o `map` não copia não chega à tela.
 */
export type IncidentResponse = {
  id: string;
  urgency?: string;
  title: string;
  segment?: string;
  devices?: number;
  startedAt?: string;
  startedMinutesAgo?: number;
  component?: string;
  deviceType?: string;
  region?: string;
  appVersion?: string;
};

/** `GET /api/v1/incidents`. */
export type IncidentsResponse = { incidents: IncidentResponse[] };

/** Urgências que a tela sabe desenhar. */
const URGENCIES = new Set<string>(["P1", "P2", "P3", "P4"]);

/** Acima desta urgência, a barra do gráfico é lida como crítica. */
const CRITICAL_URGENCIES = new Set<Urgency>(["P1", "P2"]);

/** Converte o que chegou da API no que a lista desenha, campo a campo. */
function toIncident(incident: IncidentResponse): Incident {
  const urgency = URGENCIES.has(incident.urgency ?? "")
    ? (incident.urgency as Urgency)
    : "P4";

  return {
    id: incident.id,
    urgency,
    title: incident.title,
    segment: incident.segment ?? "",
    devices: incident.devices ?? 0,
    startedAt: incident.startedAt ?? "",
    startedMinutesAgo: incident.startedMinutesAgo ?? 0,
    component: incident.component ?? "",
    deviceType: incident.deviceType ?? "",
    region: incident.region ?? "",
    appVersion: incident.appVersion ?? "",
  };
}

/**
 * Remove repetições do mesmo incidente, ficando com a ocorrência mais recente.
 *
 * O banco guarda o incidente em baldes por hora, e execuções diferentes do
 * seed gravaram o mesmo `id` em baldes distintos. A rota devolve todos; sem
 * isto, a lista repete cada caso e o gráfico soma os dispositivos duas vezes.
 */
function dedupeIncidents(incidents: Incident[]): Incident[] {
  const byId = new Map<string, Incident>();

  for (const incident of incidents) {
    const current = byId.get(incident.id);
    if (!current || incident.startedMinutesAgo < current.startedMinutesAgo) {
      byId.set(incident.id, incident);
    }
  }

  return [...byId.values()];
}

/** Hora cheia de um horário no formato `HH:MM`. Vazio quando não dá para ler. */
function hourOf(startedAt: string): string | undefined {
  const [hour] = startedAt.split(":");
  return hour && hour.length === 2 ? hour : undefined;
}

/**
 * Soma os dispositivos por hora de início.
 *
 * A barra fica crítica quando pelo menos um dos incidentes daquela hora é P1 ou
 * P2: é a urgência que manda na cor, e não o tamanho da barra, que já é a
 * altura.
 */
export function bucketsByHour(
  incidents: Incident[],
  period: ChartPeriodKey,
): ChartBucket[] {
  const byHour = new Map<string, { value: number; level: ChartLevel }>();

  for (const incident of incidents) {
    const hour = hourOf(incident.startedAt);
    if (!hour) continue;

    const current = byHour.get(hour) ?? { value: 0, level: "warning" };
    byHour.set(hour, {
      value: current.value + incident.devices,
      level:
        current.level === "critical" || CRITICAL_URGENCIES.has(incident.urgency)
          ? "critical"
          : "warning",
    });
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, bucket]) => ({
      // Em 24 horas o eixo fica com o rótulo curto; nas janelas menores, com a
      // hora cheia, que é como o horário aparece no resto da tela.
      time: period === "1440" ? `${hour}h` : `${hour}:00`,
      value: bucket.value,
      level: bucket.level,
    }));
}

/** Converte "todos" em ausência de filtro, como a API espera. */
function optional(value: string): string | undefined {
  return value === "all" ? undefined : value;
}

/**
 * Janela enviada à API, em minutos.
 *
 * Não existe "todo o período" na origem: a listagem varre baldes por hora, e
 * cobrir os 30 dias de retenção seria varrer setecentos. O recorte mais largo
 * que a tela oferece é o de 24 horas.
 */
function windowOf(period: string): string {
  return period === "all" ? "1440" : period;
}

/**
 * Lê os incidentes que exigem atenção.
 *
 * @example
 * const incidents = useResource((revision) => fetchIncidents(query, revision), [query]);
 */
export function fetchIncidents(
  query: IncidentsQuery,
  revision = 0,
): Promise<Resource<Incident[]>> {
  return loadResource<IncidentsResponse, Incident[]>({
    target: "operacional",
    path: ENDPOINTS.operacional.incidents,
    params: {
      // A rota aceita `15m`, `1h` e afins ou um número puro de minutos, que é o
      // que o seletor da tela guarda.
      window: windowOf(query.period),
      deviceType: optional(query.deviceType),
      region: optional(query.region),
      appVersion: optional(query.appVersion),
    },
    map: (response) => dedupeIncidents(response.incidents.map(toIncident)),
    fallback: () =>
      INCIDENTS.map((incident, index) => ({
        ...incident,
        devices:
          revision === 0
            ? incident.devices
            : Math.round(jitter(incident.devices, revision * 20 + index, 0.07)),
      })),
  });
}

/**
 * Lê os dispositivos de incidentes iniciados em cada horário.
 *
 * A janela é independente da lista: quem investiga costuma olhar as últimas
 * horas no gráfico enquanto mantém a lista no recorte do plantão.
 *
 * @param period - Janela do gráfico, em minutos.
 */
export function fetchAffectedDevices(
  period: ChartPeriodKey,
  revision = 0,
): Promise<Resource<ChartBucket[]>> {
  return loadResource<IncidentsResponse, ChartBucket[]>({
    target: "operacional",
    path: ENDPOINTS.operacional.incidents,
    params: { window: period },
    map: (response) =>
      bucketsByHour(dedupeIncidents(response.incidents.map(toIncident)), period),
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

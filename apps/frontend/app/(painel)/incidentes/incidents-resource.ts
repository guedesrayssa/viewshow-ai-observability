/**
 * @file incidents-resource.ts
 * Leitura dos dados da tela de Incidentes.
 *
 * A lista priorizada vem dos alertas ativos da API; a série por horário, do
 * detalhamento de erros no mesmo recorte. Enquanto a integração não existe,
 * as duas caem no conjunto de exemplo, e a tela declara isso em texto.
 */

import {
  CHART_DATASETS,
  INCIDENTS,
  type ChartBucket,
  type ChartPeriodKey,
  type Incident,
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

/** Resposta esperada da API para os alertas ativos. */
export type RealtimeAlertsResponse = {
  alerts: Incident[];
};

/** Resposta esperada da API para a série de dispositivos afetados. */
export type AffectedDevicesResponse = {
  buckets: ChartBucket[];
};

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
  return loadResource<RealtimeAlertsResponse, Incident[]>({
    path: ENDPOINTS.realtimeAlerts,
    params: {
      window: query.period === "all" ? undefined : `${query.period}m`,
      device: query.deviceType === "all" ? undefined : query.deviceType,
      region: query.region === "all" ? undefined : query.region,
      app_version: query.appVersion === "all" ? undefined : query.appVersion,
    },
    map: (response) => response.alerts,
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
 * Lê a série de dispositivos afetados por horário.
 *
 * @param period - Janela do gráfico, independente do filtro da lista.
 */
export function fetchAffectedDevices(
  period: ChartPeriodKey,
  revision = 0,
): Promise<Resource<ChartBucket[]>> {
  return loadResource<AffectedDevicesResponse, ChartBucket[]>({
    path: ENDPOINTS.errorsTop,
    params: { window: `${period}m`, group_by: "hour" },
    map: (response) => response.buckets,
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

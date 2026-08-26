/**
 * @file telemetry-resource.ts
 * Leitura dos dados da tela de Monitoramento.
 *
 * A saúde do pipeline virá do endpoint de topologia da API; a concentração
 * geográfica, da segmentação por rede. Enquanto a integração não existe, as
 * leituras caem no conjunto de exemplo e a tela declara a procedência.
 */

import {
  SOURCES,
  STATES,
  type StateTelemetry,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

/** Resposta esperada da API para a saúde do pipeline. */
export type TopologyHealthResponse = {
  sources: TelemetrySource[];
};

/** Resposta esperada da API para a concentração por unidade federativa. */
export type NetworkBreakdownResponse = {
  states: StateTelemetry[];
};

/**
 * Lê o estado das fontes de telemetria.
 *
 * A variação do conjunto de exemplo fica nas medições que de fato oscilam
 * minuto a minuto — atraso, ingestão, latência e fila. Cobertura, estado e
 * identificação da fonte permanecem, porque são o que a tabela afirma.
 */
export function fetchTelemetrySources(
  revision = 0,
): Promise<Resource<TelemetrySource[]>> {
  return loadResource<TopologyHealthResponse, TelemetrySource[]>({
    path: ENDPOINTS.rcaTopology,
    map: (response) => response.sources,
    fallback: () =>
      SOURCES.map((source, index) =>
        revision === 0
          ? source
          : {
              ...source,
              updatedSecondsAgo: Math.max(
                1,
                Math.round(jitter(source.updatedSecondsAgo, revision * 3 + index, 0.2)),
              ),
              ingestionPerMinute: Number(
                jitter(source.ingestionPerMinute, revision * 5 + index, 0.06).toFixed(2),
              ),
              processingLatency: Math.round(
                jitter(source.processingLatency, revision * 11 + index, 0.1),
              ),
              queueDepth: Number(
                jitter(source.queueDepth, revision * 13 + index, 0.12).toFixed(1),
              ),
            },
      ),
  });
}

/**
 * Lê a concentração geográfica das instabilidades, por unidade federativa.
 */
export function fetchGeographicConcentration(
  revision = 0,
): Promise<Resource<StateTelemetry[]>> {
  return loadResource<NetworkBreakdownResponse, StateTelemetry[]>({
    path: ENDPOINTS.breakdownNetwork,
    params: { dimension: "state" },
    map: (response) => response.states,
    fallback: () =>
      STATES.map((state, index) =>
        revision === 0
          ? state
          : {
              ...state,
              values: {
                instabilidade: Number(
                  jitter(
                    state.values.instabilidade,
                    revision * 17 + index,
                    0.1,
                  ).toFixed(1),
                ),
                latencia: Number(
                  jitter(state.values.latencia, revision * 19 + index, 0.08).toFixed(1),
                ),
                perda: Number(
                  jitter(state.values.perda, revision * 23 + index, 0.12).toFixed(1),
                ),
              },
            },
      ),
  });
}

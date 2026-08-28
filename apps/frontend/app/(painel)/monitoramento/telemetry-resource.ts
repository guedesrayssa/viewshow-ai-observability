/**
 * @file telemetry-resource.ts
 * Leitura dos dados da tela de Monitoramento.
 *
 * É a tela mais honesta sobre o que ainda não existe. As grandezas que ela
 * desenha — ingestão por minuto, latência de processamento, fila, DLQ,
 * cobertura por fonte e concentração por unidade federativa — não são
 * publicadas por nenhuma das duas APIs:
 *
 * - a execução do pipeline de ingestão ainda não registra taxa, duração nem
 *   cobertura (a arquitetura do serviço prevê, o serviço não existe);
 * - fila e DLQ são indisponíveis **por desenho**, não por pendência: o
 *   pipeline é em lote, sem SQS;
 * - a segmentação da telemetria aceita provedor, CDN e tipo de conexão —
 *   não há dimensão geográfica.
 *
 * A rota de topologia foi considerada e descartada como fonte desta tabela:
 * ela descreve serviços e dependências derivados de spans, e chamadas com
 * erro não são ingestão com fila. Mapear um no outro daria número certo na
 * coluna errada.
 *
 * Por isso as duas leituras daqui declaram indisponibilidade quando estão ao
 * vivo, com o motivo de cada bloco, e caem no conjunto de exemplo onde ele é
 * permitido. Quando o serviço de ingestão publicar as métricas de execução, é
 * este arquivo que passa a lê-las.
 */

import {
  SOURCES,
  STATES,
  type StateTelemetry,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";
import {
  composeResource,
  jitter,
  loadResource,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { WARNINGS } from "@/lib/data/warnings";

/** `GET /v1/analytics/rca/topology-health`, como a API o publica hoje. */
export type TopologyHealthResponse = {
  status: string;
  services: {
    service: string;
    status: string;
    calls: number;
    errors: number;
    error_rate: number | null;
    latency_ms: { p50: number | null; p95: number | null };
  }[];
  dependencies: {
    source: string;
    target: string;
    calls: number;
    errors: number;
    error_rate: number | null;
    latency_p95_ms: number | null;
  }[];
};

/** Saúde de um serviço observado pelos traces. */
export type ServiceHealth = {
  service: string;
  status: "healthy" | "degraded" | "critical";
  calls: number;
  errors: number;
  errorRate: number;
  latencyP95: number | null;
};

/** Chamada entre dois serviços, derivada dos spans pai e filho. */
export type ServiceDependency = {
  source: string;
  target: string;
  calls: number;
  errorRate: number;
};

export type ServiceTopology = {
  status: string;
  services: ServiceHealth[];
  dependencies: ServiceDependency[];
};

/** Estados de serviço que a tela sabe desenhar. */
const SERVICE_STATUSES = new Set(["healthy", "degraded", "critical"]);

/**
 * Lê a saúde dos serviços e das dependências entre eles.
 *
 * É a leitura real desta tela: vem dos spans reportados junto de eventos e
 * erros, e não do pipeline de ingestão — que continua sem instrumentação e
 * segue declarado como indisponível nos cartões de cima.
 */
export function fetchServiceTopology(
  window: string,
): Promise<Resource<ServiceTopology>> {
  return loadResource<TopologyHealthResponse, ServiceTopology>({
    target: "telemetria",
    path: ENDPOINTS.telemetria.rcaTopology,
    params: { window },
    map: (response) => ({
      status: response.status,
      services: response.services.map((service) => ({
        service: service.service,
        status: SERVICE_STATUSES.has(service.status)
          ? (service.status as ServiceHealth["status"])
          : "degraded",
        calls: service.calls,
        errors: service.errors,
        errorRate: service.error_rate ?? 0,
        latencyP95: service.latency_ms.p95,
      })),
      dependencies: response.dependencies.map((dependency) => ({
        source: dependency.source,
        target: dependency.target,
        calls: dependency.calls,
        errorRate: dependency.error_rate ?? 0,
      })),
    }),
  });
}

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
  return composeResource<TelemetrySource[]>({
    targets: ["telemetria"],
    warnings: [WARNINGS.pipelineSemInstrumentacao, WARNINGS.pipelineSemFila],
    read: async () => [],
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
  return composeResource<StateTelemetry[]>({
    targets: ["telemetria"],
    warnings: [WARNINGS.semDimensaoGeografica],
    read: async () => [],
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

/**
 * @file evidence-resource.ts
 * Leitura dos dados da tela de Evidências.
 *
 * A hipótese e as evidências virão da análise de causa provável da API
 * (`/v1/analytics/rca/...`); a série de buffering, das métricas de qualidade de
 * experiência. Enquanto isso não existe, a tela mostra o caso do INC-4821 e
 * declara a procedência em texto.
 */

import {
  BUFFERING_DATASETS,
  CHANGE_LIKELIHOODS,
  CONCENTRATION,
  CONCENTRATION_NOTE,
  EVIDENCE_SOURCES,
  HYPOTHESIS,
  INCIDENT,
  TIMELINE,
  type BufferingPeriodKey,
  type BufferingPoint,
  type EvidenceData,
} from "@/app/(painel)/evidencias/evidence-data";
import { jitter, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

/** Resposta esperada da API para a causa provável de um incidente. */
export type RcaFingerprintResponse = {
  incident: EvidenceData["incident"];
  hypothesis: EvidenceData["hypothesis"];
  concentration: EvidenceData["concentration"];
  concentration_note: string;
  sources: EvidenceData["sources"];
  timeline: EvidenceData["timeline"];
  changes: EvidenceData["changes"];
};

/** Resposta esperada da API para a série de buffer ratio. */
export type QoeTimeseriesResponse = {
  points: BufferingPoint[];
};

/**
 * Lê a hipótese e as evidências de um incidente.
 *
 * @param incidentId - Identificador do incidente em investigação.
 * @param revision - Número da leitura, usado só pelo conjunto de exemplo.
 */
export function fetchEvidence(
  incidentId: string,
  revision = 0,
): Promise<Resource<EvidenceData>> {
  return loadResource<RcaFingerprintResponse, EvidenceData>({
    path: ENDPOINTS.rcaCorrelations,
    params: { incident: incidentId },
    map: (response) => ({
      incident: response.incident,
      hypothesis: response.hypothesis,
      concentration: response.concentration,
      concentrationNote: response.concentration_note,
      sources: response.sources,
      timeline: response.timeline,
      changes: response.changes,
    }),
    fallback: () => ({
      incident: {
        ...INCIDENT,
        affectedSessions:
          revision === 0
            ? INCIDENT.affectedSessions
            : Math.round(jitter(INCIDENT.affectedSessions, revision * 7, 0.04)),
      },
      hypothesis: HYPOTHESIS,
      concentration: CONCENTRATION,
      concentrationNote: CONCENTRATION_NOTE,
      sources: EVIDENCE_SOURCES,
      timeline: TIMELINE,
      changes: CHANGE_LIKELIHOODS,
    }),
  });
}

/**
 * Lê a série de buffer ratio da janela selecionada.
 *
 * @param period - Janela do gráfico de buffering.
 */
export function fetchBuffering(
  period: BufferingPeriodKey,
  revision = 0,
): Promise<Resource<BufferingPoint[]>> {
  return loadResource<QoeTimeseriesResponse, BufferingPoint[]>({
    path: ENDPOINTS.qoeTimeseries,
    params: { window: `${period}m`, metric: "buffer_ratio" },
    map: (response) => response.points,
    fallback: () =>
      BUFFERING_DATASETS[period].map((point, index) => ({
        ...point,
        value:
          revision === 0
            ? point.value
            : Number(jitter(point.value, revision * 40 + index, 0.07).toFixed(1)),
      })),
  });
}

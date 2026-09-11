/**
 * @file evidence-resource.ts
 * Leitura e revisão dos dados da tela de Evidências.
 *
 * O incidente, as evidências e a hipótese vêm da API operacional, em três
 * leituras que a tela junta em uma. A API ainda não tem uma rota que devolva o
 * diagnóstico inteiro de uma vez; o contrato prevê uma, e quando ela existir é
 * este arquivo que muda.
 *
 * A série de travamento vem da API de telemetria, que é quem mede QoE.
 *
 * A concentração vem da segmentação de erros por modelo de dispositivo da
 * telemetria: participação real de cada modelo nos erros da janela. Linha do
 * tempo de mudanças e correlação com deploys seguem sem fonte: chegam vazias,
 * com o aviso correspondente, e a tela desenha o bloco de indisponível.
 *
 * Aqui também mora a única escrita do painel: a revisão humana da hipótese.
 */

import {
  BUFFERING_DATASETS,
  CHANGE_LIKELIHOODS,
  CONCENTRATION,
  CONCENTRATION_NOTE,
  DEPLOY_INDEX,
  DEPLOY_LABEL,
  EVIDENCE_SOURCES,
  HYPOTHESIS,
  INCIDENT,
  TIMELINE,
  type BufferingPeriodKey,
  type BufferingPoint,
  type EvidenceData,
  type EvidenceSource,
  type EvidenceStrength,
  type Hypothesis,
  type IncidentSummary,
  type ReviewStatus,
} from "@/app/(painel)/evidencias/evidence-data";
import {
  apiGet,
  ApiError,
  composeResource,
  jitter,
  loadResource,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { WARNINGS } from "@/lib/data/warnings";

/* -------------------------------------------------------------------------
 * Formatos das respostas, como a API operacional os publica hoje.
 * ---------------------------------------------------------------------- */

/** `GET /api/v1/incidents/:id`. */
export type IncidentDetailResponse = {
  id: string;
  title: string;
  urgency?: string;
  status?: string;
  statusLabel?: string;
  devices?: number;
  startedMinutesAgo?: number;
  component?: string;
  deviceType?: string;
  region?: string;
  appVersion?: string;
};

/** Um item de `GET /api/v1/incidents/:id/evidence`. */
export type EvidenceItemResponse = {
  sk?: string;
  type?: string;
  description: string;
  source?: string;
  strength?: string;
  capturedAt?: string;
};

export type EvidenceListResponse = { evidence: EvidenceItemResponse[] };

/** `GET /api/v1/incidents/:id/hypothesis`. Responde 404 sem diagnóstico. */
export type HypothesisResponse = {
  text: string;
  score: number;
  source?: string;
  createdAt?: string;
  reviewStatus?: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

/** `GET /v1/analytics/breakdown/devices` — um grupo por valor da dimensão. */
export type DevicesBreakdownResponse = {
  dimension: string;
  total_groups: number;
  breakdown: {
    value: string;
    events: number;
    sessions: number;
    errors: number;
    error_rate: number | null;
    traffic_share: number | null;
  }[];
};

/** Bloco de métricas de QoE por ponto da série. */
export type QoeTimeseriesResponse = {
  interval_seconds: number;
  points: {
    start: string;
    metrics: { rebuffer: { rate: number | null; count: number } };
  }[];
};

/** Forças de evidência que a tela sabe desenhar. */
const STRENGTHS = new Set<string>(["forte", "neutra", "contra"]);

/** Estados de revisão que a API pode ter registrado. */
const REVIEW_STATUSES = new Set<string>(["confirmed", "refuted"]);

/** Rótulo do eixo a partir do início do intervalo, no fuso de quem lê. */
function toClockLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function toIncidentSummary(
  incident: IncidentDetailResponse,
  review: ReviewStatus,
): IncidentSummary {
  return {
    id: incident.id,
    title: incident.title,
    startedMinutesAgo: incident.startedMinutesAgo ?? 0,
    severity: incident.statusLabel ?? incident.urgency ?? "Ativo",
    investigationStatus:
      review === "confirmed"
        ? "Hipótese confirmada"
        : review === "refuted"
          ? "Hipótese refutada"
          : "Em investigação",
    // A API conta dispositivos, não sessões. Chamar isso de sessões seria
    // afirmar uma medição que a origem não faz.
    affectedDevices: incident.devices ?? 0,
  };
}

function toEvidenceSource(
  item: EvidenceItemResponse,
  index: number,
): EvidenceSource {
  const strength = STRENGTHS.has(item.strength ?? "")
    ? (item.strength as EvidenceStrength)
    : "neutra";

  return {
    // O `sk` é chave física da tabela e não sai daqui; serve só para manter a
    // identidade estável entre releituras.
    id: item.sk ?? `evidencia-${index + 1}`,
    source: item.source ?? "Origem não informada",
    summary: item.description,
    strength,
    detail: item.type ? `Tipo: ${item.type}` : "Sem detalhe adicional.",
  };
}

function toHypothesis(
  hypothesis: HypothesisResponse,
  incident: IncidentDetailResponse,
): Hypothesis {
  return {
    title: hypothesis.text,
    component: incident.component ?? "Componente não informado",
    // `score` vem de 0 a 1; a barra e o selo da tela falam em porcentagem.
    confidence: Math.round((hypothesis.score ?? 0) * 100),
    summary:
      hypothesis.source === "golden-set"
        ? "Diagnóstico reaproveitado de um caso já curado com a mesma assinatura."
        : "Hipótese levantada pelo agente a partir das evidências coletadas.",
  };
}

/** Conjunto de exemplo da tela inteira. */
function exampleEvidence(): EvidenceData {
  return {
    incidentId: INCIDENT.id,
    incident: INCIDENT,
    hypothesis: HYPOTHESIS,
    reviewStatus: "pending",
    concentration: CONCENTRATION,
    concentrationNote: CONCENTRATION_NOTE,
    sources: EVIDENCE_SOURCES,
    timeline: TIMELINE,
    changes: CHANGE_LIKELIHOODS,
  };
}

/**
 * Lê o incidente, as evidências e a hipótese mais recente.
 *
 * @param incidentId - Identificador do incidente em investigação.
 * @param revision - Número da leitura, usado só pelo conjunto de exemplo.
 */
export function fetchEvidence(
  incidentId: string,
  revision = 0,
): Promise<Resource<EvidenceData>> {
  void revision;

  return composeResource<EvidenceData>({
    targets: ["operacional"],
    warnings: [WARNINGS.metricaSemFonte],
    read: async (warn) => {
      const [incident, evidenceList] = await Promise.all([
        apiGet<IncidentDetailResponse>(
          "operacional",
          ENDPOINTS.operacional.incident(incidentId),
        ),
        apiGet<EvidenceListResponse>(
          "operacional",
          ENDPOINTS.operacional.incidentEvidence(incidentId),
        ),
      ]);

      // A concentração vem da outra API, e é apoio: se a telemetria não
      // responder, o bloco declara indisponibilidade e o diagnóstico segue.
      let concentration: EvidenceData["concentration"] = [];
      let concentrationNote = "";
      try {
        const devices = await apiGet<DevicesBreakdownResponse>(
          "telemetria",
          ENDPOINTS.telemetria.breakdownDevices,
          { window: "1h", dimension: "model", limit: 8 },
        );

        const totalErrors = devices.breakdown.reduce(
          (total, group) => total + group.errors,
          0,
        );

        if (totalErrors > 0) {
          concentration = devices.breakdown
            .filter((group) => group.errors > 0)
            .sort((a, b) => b.errors - a.errors)
            .slice(0, 4)
            .map((group) => ({
              label: group.value,
              percentage: Math.round((group.errors / totalErrors) * 100),
            }));
          concentrationNote =
            "Participação de cada modelo nos erros da última hora";
        }
      } catch {
        // Sem telemetria, o bloco fica vazio e a tela explica.
      }

      // Um incidente sem diagnóstico responde 404 aqui, e isso não é falha de
      // leitura: é um estado do fluxo, e a tela precisa saber diferenciar.
      let hypothesis: HypothesisResponse | null = null;
      try {
        hypothesis = await apiGet<HypothesisResponse>(
          "operacional",
          ENDPOINTS.operacional.incidentHypothesis(incidentId),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          warn(WARNINGS.semHipotese);
        } else {
          throw error;
        }
      }

      const review: ReviewStatus = REVIEW_STATUSES.has(
        hypothesis?.reviewStatus ?? "",
      )
        ? (hypothesis?.reviewStatus as ReviewStatus)
        : "pending";

      return {
        incidentId,
        incident: toIncidentSummary(incident, review),
        hypothesis: hypothesis ? toHypothesis(hypothesis, incident) : null,
        reviewStatus: review,
        concentration,
        concentrationNote,
        sources: evidenceList.evidence.map(toEvidenceSource),
        timeline: [],
        changes: [],
      };
    },
    fallback: exampleEvidence,
  });
}

/** Série de travamento, com o marco de deploy quando ele é conhecido. */
export type BufferingSeries = {
  points: BufferingPoint[];
  /** Marco na série. `null` quando a origem não registra deploys. */
  marker: { index: number; label: string } | null;
};

/**
 * Lê a evolução da taxa de travamento no recorte.
 *
 * @param period - Janela do gráfico, em minutos.
 */
export function fetchBuffering(
  period: BufferingPeriodKey,
  revision = 0,
): Promise<Resource<BufferingSeries>> {
  return loadResource<QoeTimeseriesResponse, BufferingSeries>({
    target: "telemetria",
    path: ENDPOINTS.telemetria.qoeTimeseries,
    params: { window: `${period}m` },
    map: (response) => ({
      points: response.points.map((point) => ({
        time: toClockLabel(point.start),
        // A API devolve a fração de tempo travado; a tela fala em porcentagem.
        value: Number(((point.metrics.rebuffer.rate ?? 0) * 100).toFixed(2)),
      })),
      // A telemetria não registra deploys: sem marco, em vez de um marco no
      // lugar errado.
      marker: null,
    }),
    fallback: () => ({
      points: BUFFERING_DATASETS[period].map((point, index) => ({
        ...point,
        value:
          revision === 0
            ? point.value
            : Number(jitter(point.value, revision * 40 + index, 0.08).toFixed(1)),
      })),
      marker: { index: DEPLOY_INDEX[period], label: DEPLOY_LABEL },
    }),
  });
}

/** Resultado de uma tentativa de revisão. */
export type ReviewResult =
  | { ok: true; status: Exclude<ReviewStatus, "pending"> }
  | { ok: false; needsSignIn: boolean; message: string };

/**
 * Registra a revisão humana da hipótese.
 *
 * É a única escrita do painel, e a única rota que exige sessão: confirmar
 * promove o caso à golden set no servidor, o que a interface não desfaz.
 *
 * @param incidentId - Incidente cuja hipótese está sendo revisada.
 * @param status - `confirmed` ou `refuted`.
 *
 * @example
 * const result = await reviewHypothesis("falhas-reproducao-tvs-lg", "confirmed");
 */
export async function reviewHypothesis(
  incidentId: string,
  status: Exclude<ReviewStatus, "pending">,
): Promise<ReviewResult> {
  const configuredBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  // "/" significa "mesma origem do painel" (ver lib/data/client.ts). `new
  // URL(path, "/")` lançaria `TypeError: Invalid base URL`, por isso resolve
  // para a origem do navegador aqui, e não na leitura da variável de ambiente.
  const base =
    configuredBase === "/"
      ? typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin
      : configuredBase;

  if (!base) {
    return {
      ok: false,
      needsSignIn: false,
      message: "A API de incidentes não está configurada neste ambiente.",
    };
  }

  try {
    const response = await fetch(
      new URL(
        ENDPOINTS.operacional.incidentHypothesisReview(incidentId),
        base,
      ).toString(),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // A identidade do revisor vem da sessão no servidor, nunca do corpo.
        credentials: "include",
        body: JSON.stringify({ status }),
      },
    );

    if (response.ok) return { ok: true, status };

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        needsSignIn: true,
        message: "Sua sessão expirou. Entre novamente para registrar a revisão.",
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        needsSignIn: false,
        message: "Este incidente ainda não tem hipótese registrada.",
      };
    }

    return {
      ok: false,
      needsSignIn: false,
      message: "Não foi possível registrar a revisão agora. Tente de novo.",
    };
  } catch {
    return {
      ok: false,
      needsSignIn: false,
      message: "Não conseguimos falar com a API de incidentes.",
    };
  }
}

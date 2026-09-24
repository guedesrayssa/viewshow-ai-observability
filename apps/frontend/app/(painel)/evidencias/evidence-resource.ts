/** Diagnosis reads and optimistic human review through the public gateway. */
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
  type ReviewStatus,
} from "@/app/(painel)/evidencias/evidence-data";
import {
  gatewayUrl,
  jitter,
  loadResource,
  type Resource,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { reportRum } from "@/lib/rum";

type DiagnosisResponse = {
  incident: {
    id: string;
    title: string;
    priority: string;
    status: string;
    startedAt: string;
    impact: {
      affectedDevices: {
        value: number | null;
        measurement: { status: string };
      };
    };
    primaryComponent: { id: string; name: string } | null;
  };
  diagnosis: {
    status: "not_started" | "processing" | "ready" | "inconclusive" | "failed";
    summary: string | null;
    primaryHypothesisId: string | null;
    confidence: number | null;
    hypotheses: Array<{
      id: string;
      statement: string;
      component: { id: string; name: string } | null;
      probability: number | null;
      rationale: string | null;
      review: { status: ReviewStatus | "inconclusive"; version: number };
    }>;
  };
  evidence: Array<{
    id: string;
    type: string;
    title: string;
    statement: string;
    relation: "supports" | "contradicts" | "context";
    strength: "strong" | "moderate" | "weak";
    source: { type: string; name: string };
    quality: { status: string; flags: string[] };
  }>;
  charts: {
    buffering: BufferingContract | null;
    concentrations?: Array<{ label: string; percentage: number }>;
    concentrationNote?: string;
  };
  timeline?: Array<{ timestamp: string; label: string; source: string; tone: "info" | "warning" | "critical" | "navy" }>;
  changes?: Array<{ label: string; cause: string; percentage: number; tone: "info" | "warning" | "critical" }>;
};

type BufferingContract = {
  points: Array<{ timestamp: string; value: number }>;
  marker?: { timestamp: string; label: string } | null;
};

const reviewTargets = new Map<
  string,
  { hypothesisId: string; expectedVersion: number }
>();

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

function toClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function toEvidence(
  item: DiagnosisResponse["evidence"][number],
): EvidenceSource {
  return {
    id: item.id,
    source: item.source.name,
    summary: item.statement,
    strength:
      item.relation === "contradicts"
        ? "contra"
        : item.strength === "strong"
          ? "forte"
          : "neutra",
    detail: [item.title, item.type, ...item.quality.flags]
      .filter(Boolean)
      .join(" · "),
  };
}

function toData(response: DiagnosisResponse): EvidenceData {
  const devices = response.incident.impact.affectedDevices.value;
  const hypothesis =
    response.diagnosis.hypotheses.find(
      (item) => item.id === response.diagnosis.primaryHypothesisId,
    ) ?? response.diagnosis.hypotheses[0];
  if (hypothesis) {
    reviewTargets.set(response.incident.id, {
      hypothesisId: hypothesis.id,
      expectedVersion: hypothesis.review.version,
    });
  } else {
    reviewTargets.delete(response.incident.id);
  }
  const reviewStatus: ReviewStatus =
    hypothesis?.review.status === "confirmed" ||
    hypothesis?.review.status === "refuted"
      ? hypothesis.review.status
      : "pending";
  return {
    incidentId: response.incident.id,
    incident: {
      id: response.incident.id,
      title: response.incident.title,
      startedMinutesAgo: Math.max(
        0,
        Math.round(
          (Date.now() - new Date(response.incident.startedAt).getTime()) /
            60_000,
        ),
      ),
      severity: response.incident.priority,
      investigationStatus: response.incident.status,
      affectedDevices: devices,
    },
    hypothesis: hypothesis
      ? {
          title: hypothesis.statement,
          component: hypothesis.component?.name ?? "—",
          confidence: hypothesis.probability === null ? null : Math.round(hypothesis.probability * 100),
          summary: hypothesis.rationale ?? response.diagnosis.summary ?? "",
        }
      : null,
    reviewStatus,
    concentration: response.charts.concentrations ?? [],
    concentrationNote: response.charts.concentrationNote ?? "",
    sources: response.evidence.map(toEvidence),
    timeline: (response.timeline ?? []).map((mark) => ({
      ...mark,
      time: toClock(mark.timestamp),
    })),
    changes: response.changes ?? [],
  };
}

export function fetchEvidence(
  incidentId: string,
): Promise<Resource<EvidenceData>> {
  return loadResource<DiagnosisResponse, EvidenceData>({
    path: ENDPOINTS.diagnosis(incidentId),
    map: toData,
    fallback: exampleEvidence,
  });
}

export type BufferingSeries = {
  points: BufferingPoint[];
  marker: { index: number; label: string } | null;
  historical?: boolean;
  observedAt?: string;
};

export function fetchBuffering(
  incidentId: string,
  period: BufferingPeriodKey,
  revision = 0,
): Promise<Resource<BufferingSeries>> {
  return loadResource<DiagnosisResponse, BufferingSeries>({
    path: ENDPOINTS.diagnosis(incidentId),
    map: (response) => {
      const chart = response.charts.buffering;
      if (!chart)
        throw new Error(
          "A série de buffering não está disponível para este incidente.",
        );
      const recent = chart.points.filter((point) => new Date(point.timestamp).getTime() >= Date.now() - Number(period) * 60_000);
      const selected = recent.length ? recent : chart.points;
      const points = selected.map((point) => ({
        time: toClock(point.timestamp),
        value: point.value,
      }));
      const markerIndex = chart.marker
        ? points.findIndex(
            (_, index) =>
              selected[index]?.timestamp === chart.marker?.timestamp,
          )
        : -1;
      return {
        points,
        marker:
          chart.marker && markerIndex >= 0
            ? { index: markerIndex, label: chart.marker.label }
            : null,
        historical: recent.length === 0,
        observedAt: selected.at(-1)?.timestamp,
      };
    },
    fallback: () => ({
      points: BUFFERING_DATASETS[period].map((point, index) => ({
        ...point,
        value:
          revision === 0
            ? point.value
            : Number(
                jitter(point.value, revision * 40 + index, 0.08).toFixed(1),
              ),
      })),
      marker: { index: DEPLOY_INDEX[period], label: DEPLOY_LABEL },
    }),
  });
}

export type ReviewResult =
  | { ok: true; status: Exclude<ReviewStatus, "pending"> }
  | { ok: false; needsSignIn: boolean; message: string };

export async function reviewHypothesis(
  incidentId: string,
  status: Exclude<ReviewStatus, "pending">,
): Promise<ReviewResult> {
  const target = reviewTargets.get(incidentId);
  if (!target) {
    return {
      ok: false,
      needsSignIn: false,
      message: "A hipótese atual precisa ser recarregada antes da revisão.",
    };
  }
  try {
    const response = await fetch(
      gatewayUrl(ENDPOINTS.review(incidentId, target.hypothesisId)),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          status,
          expectedVersion: target.expectedVersion,
        }),
      },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        data: { review: { version: number } };
      };
      reviewTargets.set(incidentId, {
        ...target,
        expectedVersion: body.data.review.version,
      });
      return { ok: true, status };
    }
    reportRum("frontend_api_fetch_errors_total", 1);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        needsSignIn: true,
        message:
          "Sua sessão expirou. Entre novamente para registrar a revisão.",
      };
    }
    if (response.status === 409) {
      return {
        ok: false,
        needsSignIn: false,
        message:
          "A hipótese foi revisada por outra sessão. Recarregue os dados.",
      };
    }
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      ok: false,
      needsSignIn: false,
      message:
        body?.error?.message ?? "Não foi possível registrar a revisão agora.",
    };
  } catch {
    reportRum("frontend_api_fetch_errors_total", 1);
    return {
      ok: false,
      needsSignIn: false,
      message: "Não conseguimos falar com o gateway.",
    };
  }
}

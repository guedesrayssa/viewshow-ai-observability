/** Diagnosis reads and optimistic human review through the public gateway. */
import {
  type BufferingSeries,
  type DiagnosisStatus,
  type EvidenceData,
  type EvidenceField,
  type EvidenceSource,
  type IncidentSummary,
  type ReviewStatus,
} from "@/app/(painel)/incidentes/detalhe/evidence-data";
import { gatewayUrl, loadResource, type Resource } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { formatDateTime, minutesSince } from "@/lib/format";
import { reportRum } from "@/lib/rum";

export type { BufferingSeries } from "@/app/(painel)/incidentes/detalhe/evidence-data";

type DiagnosisResponse = {
  incident: {
    id: string;
    number?: string | null;
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
    status: DiagnosisStatus;
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
    eventId: string;
    incidentId: string;
    type: string;
    title?: string | null;
    statement?: string | null;
    relation: "supports" | "contradicts" | "context";
    hypothesisIds: string[];
    strength: "strong" | "moderate" | "weak";
    observedAt: string | null;
    source: {
      type: string;
      name: string;
      dataset: string;
      recordId: string;
    };
    correlation: {
      correlationId: string;
      incidentId: string;
      ruleVersion: string;
      timeDistanceSeconds: number;
      matchedFields: Array<{
        eventField: string;
        incidentField: string;
        value: string;
      }>;
    };
    quality: {
      status: string;
      coverageRatio: number | null;
      flags: string[];
    };
  }>;
  charts: {
    buffering: BufferingContract | null;
    concentrations: Array<{ label: string; percentage: number }>;
    concentrationNote: string;
  };
  timeline: Array<{
    timestamp: string;
    label: string;
    source: string;
    tone: "info" | "warning" | "critical" | "navy";
  }>;
  changes: Array<{
    label: string;
    cause: string;
    percentage: number;
    tone: "info" | "warning" | "critical";
  }>;
  dataQuality: {
    status: string;
    coverageRatio: number | null;
    observedThrough: string | null;
    gaps: string[];
  };
};

type BufferingContract = {
  points: Array<{ timestamp: string; value: number }>;
  marker?: { timestamp: string; label: string } | null;
};

const reviewTargets = new Map<
  string,
  { hypothesisId: string; expectedVersion: number }
>();

function toClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Distância entre o evento e o incidente, em palavras. */
function formatDistance(seconds: number): string {
  const absolute = Math.abs(seconds);
  const amount =
    absolute < 60
      ? `${absolute} s`
      : absolute < 3600
        ? `${Math.round(absolute / 60)} min`
        : `${Math.round(absolute / 3600)} h`;
  if (seconds === 0) return "no mesmo instante";
  return seconds < 0 ? `${amount} antes do início` : `${amount} após o início`;
}

function toEvidence(
  item: DiagnosisResponse["evidence"][number],
): EvidenceSource {
  const matched = item.correlation.matchedFields.map(
    (field) => `${field.eventField} = ${field.value}`,
  );
  // A lista precisa diferenciar uma evidência da outra. O enunciado da
  // origem vem primeiro; sem ele, o que casou com o incidente e quando.
  const summary =
    item.statement?.trim() ||
    item.title?.trim() ||
    [matched[0], formatDistance(item.correlation.timeDistanceSeconds)]
      .filter(Boolean)
      .join(" · ");

  const fields: EvidenceField[] = [
    { label: "Evento", value: item.eventId },
    { label: "Conjunto de dados", value: item.source.dataset },
    { label: "Registro de origem", value: item.source.recordId },
    { label: "Horário", value: item.observedAt ? formatDateTime(item.observedAt) : "ausente na origem" },
    { label: "Distância do início", value: formatDistance(item.correlation.timeDistanceSeconds) },
    { label: "Regra de correlação", value: item.correlation.ruleVersion },
    ...(matched.length > 0
      ? [{ label: "Campos casados", value: matched.join(", ") }]
      : []),
    {
      label: "Qualidade",
      value: [item.quality.status, ...item.quality.flags].join(" · "),
    },
  ];

  return {
    id: item.id,
    eventId: item.eventId,
    incidentId: item.incidentId,
    observedAt: item.observedAt,
    qualityStatus: item.quality.status,
    qualityFlags: item.quality.flags,
    source: item.source.name,
    dataset: item.source.dataset,
    type: item.type,
    relation: item.relation,
    strength: item.strength,
    summary,
    fields,
  };
}

function toSummary(incident: DiagnosisResponse["incident"]): IncidentSummary {
  return {
    id: incident.id,
    number: incident.number ?? null,
    title: incident.title,
    startedAt: incident.startedAt,
    startedMinutesAgo: minutesSince(incident.startedAt),
    severity: incident.priority,
    investigationStatus: incident.status,
    affectedDevices: incident.impact.affectedDevices.value,
    component: incident.primaryComponent?.name ?? null,
  };
}

function toBuffering(chart: BufferingContract | null): BufferingSeries | null {
  if (!chart || chart.points.length === 0) return null;
  const points = chart.points.map((point) => ({
    time: toClock(point.timestamp),
    value: point.value,
  }));
  const markerIndex = chart.marker
    ? chart.points.findIndex((point) => point.timestamp === chart.marker?.timestamp)
    : -1;
  return {
    points,
    marker:
      chart.marker && markerIndex >= 0
        ? { index: markerIndex, label: chart.marker.label }
        : null,
  };
}

function toData(response: DiagnosisResponse): EvidenceData {
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
    incident: toSummary(response.incident),
    diagnosisStatus: response.diagnosis.status,
    hypothesis: hypothesis
      ? {
          title: hypothesis.statement,
          component: hypothesis.component?.name ?? "—",
          confidence:
            hypothesis.probability === null
              ? null
              : Math.round(hypothesis.probability * 100),
          summary: hypothesis.rationale ?? response.diagnosis.summary ?? "",
        }
      : null,
    reviewStatus,
    concentration: response.charts.concentrations ?? [],
    concentrationNote: response.charts.concentrationNote ?? "",
    sources: (response.evidence ?? []).map(toEvidence),
    buffering: toBuffering(response.charts.buffering),
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
  });
}

/**
 * Só o resumo do incidente, para o cabeçalho das abas que não desenham o
 * diagnóstico (Eventos). A API não tem uma rota de incidente avulsa: o resumo
 * sai da mesma leitura do diagnóstico.
 */
export function fetchIncidentSummary(
  incidentId: string,
): Promise<Resource<IncidentSummary>> {
  return loadResource<DiagnosisResponse, IncidentSummary>({
    path: ENDPOINTS.diagnosis(incidentId),
    map: (response) => toSummary(response.incident),
  });
}

export type ReanalyzeResult =
  | { ok: true }
  | { ok: false; needsSignIn: boolean; message: string };

/**
 * Pede uma nova análise automática do incidente.
 *
 * A API aceita o pedido (202) e processa em segundo plano; o diagnóstico novo
 * aparece numa leitura seguinte. A chave de idempotência evita dois pedidos
 * quando o mesmo clique é reenviado.
 */
export async function requestReanalysis(
  incidentId: string,
): Promise<ReanalyzeResult> {
  try {
    const response = await fetch(gatewayUrl(ENDPOINTS.reanalyze(incidentId)), {
      method: "POST",
      credentials: "include",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (response.ok) return { ok: true };

    reportRum("frontend_api_fetch_errors_total", 1);
    if (response.status === 401) {
      return {
        ok: false,
        needsSignIn: true,
        message: "Sua sessão expirou. Entre novamente para pedir a reanálise.",
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        needsSignIn: false,
        message: "Seu perfil não tem permissão para pedir a reanálise.",
      };
    }
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (body?.error?.code === "FEATURE_UNAVAILABLE") {
      return {
        ok: false,
        needsSignIn: false,
        message:
          "A reanálise manual ainda não está habilitada neste ambiente. O diagnóstico automático continua rodando.",
      };
    }
    if (response.status === 409) {
      return {
        ok: false,
        needsSignIn: false,
        message: "Já existe uma análise em andamento para este incidente.",
      };
    }
    return {
      ok: false,
      needsSignIn: false,
      message: body?.error?.message ?? "Não foi possível pedir a reanálise agora.",
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

function idempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `reanalyze-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    if (response.status === 401) {
      return {
        ok: false,
        needsSignIn: true,
        message:
          "Sua sessão expirou. Entre novamente para registrar a revisão.",
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        needsSignIn: false,
        message: "Seu perfil não tem permissão para revisar hipóteses.",
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

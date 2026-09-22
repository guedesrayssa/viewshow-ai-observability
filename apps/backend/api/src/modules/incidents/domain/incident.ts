import { createHash } from "node:crypto";
import type {
  DiagnosisData,
  IncidentDto,
  Measurement,
} from "@view-show/contracts";

export type PhysicalItem = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const iso = (value: unknown): string | null => {
  const candidate = text(value);
  if (!candidate) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const opaquePhysicalId = (prefix: string, value: unknown): string =>
  `${prefix}_${createHash("sha256")
    .update(String(value ?? "missing"))
    .digest("hex")
    .slice(0, 20)}`;

function measurement(
  value: number | null,
  status: "measured" | "estimated",
  item: PhysicalItem,
): Measurement {
  const observedThrough = iso(
    item.observedThrough ?? item.updatedAt ?? item.capturedAt,
  );
  const coverage = number(item.coverageRatio);
  return {
    status: value === null ? "unknown" : status,
    source: text(item.source) ?? "operational-read-model",
    coverageRatio:
      coverage !== null && coverage >= 0 && coverage <= 1 ? coverage : null,
    observedThrough,
  };
}

function incidentTimestamp(item: PhysicalItem, now: Date): string {
  const direct = iso(item.startedAt ?? item.started_at);
  if (direct) return direct;
  const minutes = number(item.startedMinutesAgo);
  if (minutes === null)
    throw new Error("incident read model has no start timestamp");
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function priority(value: unknown): IncidentDto["priority"] {
  if (value === "P1" || value === "P2" || value === "P3" || value === "P4")
    return value;
  throw new Error("incident read model has no valid priority");
}

function status(value: unknown): IncidentDto["status"] {
  if (
    value === "detected" ||
    value === "investigating" ||
    value === "confirmed" ||
    value === "resolved" ||
    value === "closed"
  )
    return value;
  if (value === "success") return "resolved";
  if (value === "critical" || value === "warning") return "investigating";
  throw new Error("incident read model has no valid status");
}

export function itemKind(
  item: PhysicalItem,
): "incident" | "evidence" | "hypothesis" | "event" | "unknown" {
  const explicit = text(item.itemType)?.toLowerCase();
  if (
    explicit === "incident" ||
    explicit === "evidence" ||
    explicit === "hypothesis" ||
    explicit === "event"
  )
    return explicit;
  const sortKey = text(item.sk);
  if (!sortKey) return "unknown";
  if (/^INCIDENT#[^#]+$/.test(sortKey)) return "incident";
  if (/^(?:INCIDENT#[^#]+#)?EVIDENCE#/.test(sortKey)) return "evidence";
  if (/^(?:INCIDENT#[^#]+#)?HYPOTHESIS#/.test(sortKey)) return "hypothesis";
  if (/^EVENT#/.test(sortKey)) return "event";
  return "unknown";
}

export function toIncidentDto(
  item: PhysicalItem,
  hypotheses: readonly PhysicalItem[] = [],
  now = new Date(),
): IncidentDto {
  const id = text(item.id ?? item.incidentId);
  if (!id) throw new Error("incident read model has no canonical id");
  const title = text(item.title);
  if (!title) throw new Error("incident read model has no title");
  const devices = number(item.affectedDevices ?? item.devices);
  const sessions = number(item.affectedSessions);
  const share = number(item.shareOfObservedSessions);
  const componentName = text(item.componentName ?? item.component);
  const latest = latestHypothesis(hypotheses);
  const component = componentName
    ? {
        id: text(item.componentId) ?? opaquePhysicalId("cmp", componentName),
        name: componentName,
      }
    : null;
  const scopes = [
    ["deviceType", item.deviceType],
    ["region", item.region],
    ["appVersion", item.appVersion],
  ] as const;
  return {
    id,
    number: text(item.number),
    title,
    priority: priority(item.priority ?? item.urgency),
    status: status(item.status),
    startedAt: incidentTimestamp(item, now),
    detectedAt: iso(item.detectedAt),
    endedAt: iso(item.endedAt),
    impact: {
      affectedDevices: {
        value: devices,
        unit: "devices",
        measurement: measurement(devices, "estimated", item),
      },
      affectedSessions: {
        value: sessions,
        unit: "sessions",
        measurement: measurement(sessions, "measured", item),
      },
      shareOfObservedSessions: {
        value: share,
        unit: "ratio",
        measurement: measurement(share, "measured", item),
      },
    },
    primaryComponent: component,
    scopeSummary: scopes.flatMap(([dimension, raw]) => {
      const value = text(raw);
      return value ? [{ dimension, value, name: value }] : [];
    }),
    diagnosis: latest
      ? {
          status: "ready",
          primaryHypothesisId: hypothesisId(latest),
          confidence: number(latest.probability ?? latest.score),
          reviewStatus: reviewStatus(latest.reviewStatus),
        }
      : {
          status: "not_started",
          primaryHypothesisId: null,
          confidence: null,
          reviewStatus: "pending",
        },
  };
}

export function hypothesisId(item: PhysicalItem): string {
  return text(item.id ?? item.hypothesisId) ?? opaquePhysicalId("hyp", item.sk);
}

export function latestHypothesis(
  items: readonly PhysicalItem[],
): PhysicalItem | null {
  return (
    [...items].sort((left, right) => {
      const leftVersion = number(left.version) ?? -1;
      const rightVersion = number(right.version) ?? -1;
      if (leftVersion !== rightVersion) return rightVersion - leftVersion;
      return (
        iso(right.createdAt)?.localeCompare(iso(left.createdAt) ?? "") ?? 0
      );
    })[0] ?? null
  );
}

function reviewStatus(
  value: unknown,
): "pending" | "confirmed" | "refuted" | "inconclusive" {
  return value === "confirmed" ||
    value === "refuted" ||
    value === "inconclusive"
    ? value
    : "pending";
}

function evidenceStrength(value: unknown): "strong" | "moderate" | "weak" {
  if (value === "strong" || value === "forte") return "strong";
  if (value === "weak" || value === "contra") return "weak";
  return "moderate";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function diagnosisPresentation(item: PhysicalItem): Pick<DiagnosisData, "charts" | "timeline" | "changes"> {
  const projection = record(item.diagnosisProjection);
  const buffering = record(projection?.buffering);
  const points = (Array.isArray(buffering?.points) ? buffering.points : []).flatMap((entry) => {
    const point = record(entry);
    const timestamp = iso(point?.timestamp);
    const value = number(point?.value);
    return timestamp && value !== null ? [{ timestamp, value }] : [];
  });
  const rawMarker = record(buffering?.marker);
  const markerTimestamp = iso(rawMarker?.timestamp);
  const markerLabel = text(rawMarker?.label);
  const concentrations = (Array.isArray(projection?.concentrations) ? projection.concentrations : []).flatMap((entry) => {
    const slice = record(entry);
    const label = text(slice?.label);
    const percentage = number(slice?.percentage);
    return label && percentage !== null && percentage >= 0 && percentage <= 100
      ? [{ label, percentage }] : [];
  });
  const timeline = (Array.isArray(projection?.timeline) ? projection.timeline : []).flatMap((entry) => {
    const mark = record(entry);
    const timestamp = iso(mark?.timestamp);
    const label = text(mark?.label);
    const source = text(mark?.source);
    const tone = mark?.tone;
    return timestamp && label && source && (tone === "info" || tone === "warning" || tone === "critical" || tone === "navy")
      ? [{ timestamp, label, source, tone: tone as DiagnosisData["timeline"][number]["tone"] }] : [];
  });
  const changes = (Array.isArray(projection?.changes) ? projection.changes : []).flatMap((entry) => {
    const change = record(entry);
    const label = text(change?.label);
    const cause = text(change?.cause);
    const percentage = number(change?.percentage);
    const tone = change?.tone;
    return label && cause && percentage !== null && (tone === "info" || tone === "warning" || tone === "critical")
      ? [{ label, cause, percentage, tone: tone as DiagnosisData["changes"][number]["tone"] }] : [];
  });
  return {
    charts: {
      buffering: points.length ? {
        points,
        marker: markerTimestamp && markerLabel && points.some((point) => point.timestamp === markerTimestamp)
          ? { timestamp: markerTimestamp, label: markerLabel } : null,
      } : null,
      concentrations,
      concentrationNote: text(projection?.concentrationNote) ?? "",
    },
    timeline,
    changes,
  };
}

export function toDiagnosisData(
  incidentItem: PhysicalItem,
  children: readonly PhysicalItem[],
  now = new Date(),
): DiagnosisData {
  const hypotheses = children.filter(
    (item) =>
      itemKind(item) === "hypothesis" &&
      text(item.statement ?? item.text) !== null &&
      number(item.probability ?? item.score) !== null,
  );
  const evidence = children.filter(
    (item) =>
      itemKind(item) === "evidence" &&
      text(item.statement ?? item.description) !== null,
  );
  const incident = toIncidentDto(incidentItem, hypotheses, now);
  const ranked = [...hypotheses]
    .sort(
      (left, right) =>
        (number(right.probability ?? right.score) ?? 0) -
        (number(left.probability ?? left.score) ?? 0),
    )
    .map((item, index) => ({
      id: hypothesisId(item),
      rank: index + 1,
      statement: text(item.statement ?? item.text) as string,
      component: incident.primaryComponent,
      probability: number(item.probability ?? item.score) as number,
      rationale: text(item.rationale),
      review: {
        status: reviewStatus(item.reviewStatus),
        note: text(item.reviewNote),
        reviewedAt: iso(item.reviewedAt),
        version: number(item.reviewVersion ?? item.version) ?? 0,
      },
    }));
  const latest = latestHypothesis(hypotheses);
  const presentation = diagnosisPresentation(incidentItem);
  return {
    incident,
    diagnosis: {
      status: latest ? "ready" : "not_started",
      generatedAt: latest ? iso(latest.generatedAt ?? latest.createdAt) : null,
      summary: latest ? text(latest.summary ?? latest.explanation) : null,
      primaryHypothesisId: latest ? hypothesisId(latest) : null,
      confidence: latest ? number(latest.probability ?? latest.score) : null,
      hypotheses: ranked,
    },
    evidence: evidence.map((item) => ({
      id: text(item.id ?? item.evidenceId) ?? opaquePhysicalId("evi", item.sk),
      type: text(item.type) ?? "metric_deviation",
      title: (text(item.title) ?? text(item.description)) as string,
      statement: text(item.statement ?? item.description) as string,
      relation:
        item.relation === "contradicts"
          ? "contradicts"
          : item.relation === "context"
            ? "context"
            : "supports",
      hypothesisIds: ranked.map((hypothesis) => hypothesis.id),
      strength: evidenceStrength(item.strength),
      observedAt: iso(item.observedAt ?? item.capturedAt),
      source: {
        type: text(item.sourceType) ?? "operational_telemetry",
        name: text(item.source) ?? "Argus",
      },
      quality: {
        status: item.qualityStatus === "verified" ? "verified" : "partial",
        coverageRatio: number(item.coverageRatio),
        flags:
          item.qualityStatus === "verified" ? [] : ["QUALITY_NOT_VERIFIED"],
      },
    })),
    charts: presentation.charts,
    timeline: presentation.timeline,
    changes: presentation.changes,
    dataQuality: {
      status: evidence.length > 0 && presentation.charts.buffering ? "sufficient" : evidence.length > 0 ? "limited" : "insufficient",
      coverageRatio: number(incidentItem.coverageRatio),
      observedThrough: iso(incidentItem.observedThrough),
      gaps: presentation.charts.buffering ? [] : ["INGESTION_PROJECTIONS_NOT_AVAILABLE"],
    },
  };
}

import type { EventDto, EvidenceDto, EventsQuery } from "@view-show/contracts";
import type { ActiveDatasetSnapshot } from "../../datasets/ports/active-dataset-resolver.js";
import type { PhysicalItem } from "../domain/incident.js";

export interface ActiveIncidentProjection {
  readonly observedThrough: string;
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly incidents: readonly {
    readonly incidentId: string;
    readonly number: string | null;
    readonly openedAt: string;
    readonly state: string | null;
    readonly priority: "P1" | "P2" | "P3" | "P4";
  }[];
}

export interface IncidentBundle {
  readonly incident: PhysicalItem | null;
  readonly children: readonly PhysicalItem[];
}

export interface EventProjectionStatus {
  readonly observedThrough: string | null;
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly qualityFlags: readonly string[];
}

export interface EventPagePosition {
  readonly day: string;
  readonly sortKey: string;
}

export interface EventReadRequest {
  readonly incidentId: string | null;
  readonly from: string;
  readonly to: string;
  readonly search?: string;
  readonly category?: string;
  readonly sourceDataset?: string;
  readonly correlation: EventsQuery["correlation"];
  readonly sort: EventsQuery["sort"];
  readonly limit: number;
  readonly position: EventPagePosition | null;
}

export interface EventReadPage {
  readonly items: readonly EventDto[];
  readonly categoryStats: readonly {
    readonly category: EventDto["category"];
    readonly count: number;
  }[];
  readonly facets: {
    readonly categories: readonly EventDto["category"][];
    readonly sourceDatasets: readonly string[];
    readonly correlationStatuses: readonly ("linked" | "unlinked")[];
  };
  readonly next: EventPagePosition | null;
}

export interface ReviewWrite {
  readonly key: Readonly<Record<string, unknown>>;
  readonly expectedVersion: number;
  readonly status: "confirmed" | "refuted" | "inconclusive";
  readonly note: string | null;
  readonly reviewedAt: string;
  readonly reviewerId: string;
}

export interface IncidentRepository {
  activeProjection(
    active: ActiveDatasetSnapshot,
  ): Promise<ActiveIncidentProjection | null>;
  listBetween(from: Date, to: Date): Promise<readonly PhysicalItem[]>;
  bundle(incidentId: string): Promise<IncidentBundle>;
  eventProjection(
    active: ActiveDatasetSnapshot,
  ): Promise<EventProjectionStatus | null>;
  listEvents(
    active: ActiveDatasetSnapshot,
    request: EventReadRequest,
  ): Promise<EventReadPage>;
  getEvent(
    active: ActiveDatasetSnapshot,
    eventId: string,
    incidentId: string | null,
  ): Promise<EventDto | null>;
  /**
   * Evidências do incidente. Com `analysisRunId`, os fatos A′ do worker ficam
   * restritos aos dessa execução; as evidências da ingestão nunca são filtradas.
   */
  listEvidence(
    active: ActiveDatasetSnapshot,
    incidentId: string,
    analysisRunId?: string,
  ): Promise<readonly EvidenceDto[]>;
  listHypotheses(
    active: ActiveDatasetSnapshot,
    incidentId: string,
  ): Promise<readonly PhysicalItem[]>;
  latestDiagnosis(
    active: ActiveDatasetSnapshot,
    incidentId: string,
  ): Promise<PhysicalItem | null>;
  writeReview(write: ReviewWrite): Promise<PhysicalItem>;
}

export interface ReviewFeedbackPort {
  publish(review: {
    readonly incidentId: string;
    readonly hypothesisId: string;
    readonly status: string;
  }): Promise<"accepted" | "unavailable">;
}

export interface ReanalysisPublisherPort {
  publish(request: {
    incidentId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: "MANUAL_REQUEST";
  }): Promise<"accepted" | "unavailable">;
}

/** Reserved consumer boundary for the future agentic PR; never invoked here. */
export interface AgenticDiagnosisPort {
  requestDiagnosis(incidentId: string): Promise<"accepted" | "unavailable">;
}

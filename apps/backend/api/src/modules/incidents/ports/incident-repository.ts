import type { PhysicalItem } from "../domain/incident.js";

export interface IncidentBundle {
  readonly incident: PhysicalItem | null;
  readonly children: readonly PhysicalItem[];
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
  listBetween(from: Date, to: Date): Promise<readonly PhysicalItem[]>;
  bundle(incidentId: string): Promise<IncidentBundle>;
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

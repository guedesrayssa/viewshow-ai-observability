import type { WindowedEvent } from "../contracts/analysis-event.js";
import type { MlSignal } from "../domain/ml-result.js";

export class AnalysisError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
export interface SeriesDefinition { metric: string; seriesId: string; unit: string; grainSeconds: number }
export interface AnalysisScope {
  id: string; source: string; entity: string; priority: "P1" | "P2" | "P3" | "P4";
  series: SeriesDefinition[]; detectorMetrics: string[];
  materiality?: { metric: string; minimum: number }[];
  episodeWindowSeconds?: number;
  presentation?: {
    bufferingMetric?: string;
    bufferingScale?: number;
    affectedDevicesMetric?: string;
    concentrations?: { metric: string; label: string }[];
    concentrationNote?: string;
  };
}
export interface Observation {
  id: string; datasetVersion: string; scopeId: string; metric: string; unit: string;
  timestamp: string; grainSeconds: number; value: number | null;
}
export interface Fact {
  id: string; scopeId: string; metric: string; unit: string;
  method: "mean" | "ratio-of-sums"; start: string; split: string; end: string;
  reference: number | null; current: number | null;
  referenceCount: number; currentCount: number; expectedPoints: number;
  direction: "increase" | "decrease" | "stable" | "unavailable";
  sourceIds: string[]; statement: string;
}
export interface PreparedContext {
  version: "a-prime-context-v1"; datasetVersion: string; scopeId: string; cutoff: string;
  signal: MlSignal; facts: Fact[]; gaps: string[]; hash: string;
}
export interface Interpretation {
  status: "ready" | "pending"; observations: Fact[];
  hypotheses: { id: string; title: string; explanation: string; supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[]; reviewStatus: "pending" }[];
  nextChecks: { question: string; requiredData: string[]; available: boolean }[];
  reasons: string[]; model: string | null; provider: string | null; promptVersion: string;
}
export interface DiagnosisProjection {
  impact: {
    affectedDevices: {
      value: number;
      observedThrough: string;
      coverageRatio: number;
      source: string;
    } | null;
  };
  buffering: {
    points: { timestamp: string; value: number }[];
    marker: null;
  } | null;
  concentrations: { label: string; percentage: number }[];
  concentrationNote: string;
}
export interface ModelResult {
  signals: MlSignal[]; reasons: string[]; historyDays: number; historyPoints: number;
  coverage: number; modelVersion: string;
}
export interface ScopeCheckpoint {
  event: WindowedEvent; scope: AnalysisScope; result: ModelResult;
  context: PreparedContext | null; incidentId: string | null; predictionId: string | null;
  presentation?: DiagnosisProjection | null;
  diagnosis?: Interpretation; diagnosticFailure?: string;
  episodeStarted?: boolean;
}
export interface Lease { runId: string; owner: string }
export interface AnalysisStore {
  acquire(runId: string, owner: string, now: number, leaseMs: number, fingerprint: string): Promise<"acquired" | "busy" | "complete">;
  renew(lease: Lease, now: number, leaseMs: number): Promise<void>;
  finish(lease: Lease, state: "SUCCEEDED" | "RETRY_PENDING" | "FAILED", now: number, code?: string): Promise<void>;
  checkpoint(lease: Lease, scopeId: string): Promise<ScopeCheckpoint | null>;
  saveCheckpoint(lease: Lease, scopeId: string, value: ScopeCheckpoint): Promise<void>;
  resolveIncident(id: string): Promise<{ event: WindowedEvent; scope: AnalysisScope; incidentId: string }>;
  correlate(lease: Lease, event: WindowedEvent, scope: AnalysisScope, correlationMs: number): Promise<{ incidentId: string; isNew: boolean }>;
  saveResult(lease: Lease, checkpoint: ScopeCheckpoint): Promise<void>;
  saveDiagnosis(lease: Lease, checkpoint: ScopeCheckpoint): Promise<void>;
  validatePredictions(lease: Lease, event: WindowedEvent, scope: AnalysisScope, rows: Observation[], toleranceMs: number): Promise<void>;
}
export interface ObservationReader {
  read(event: WindowedEvent, scope: AnalysisScope, from: string): Promise<Observation[]>;
}
export interface Delivery { id: string; receipt: string; body: string; receives: number }
export interface AnalysisQueue {
  receive(): Promise<Delivery[]>;
  acknowledge(receipt: string): Promise<void>;
  visibility(receipt: string, seconds: number): Promise<void>;
  deadLetter(delivery: Delivery, code: string, metadata: Record<string, unknown>): Promise<void>;
}
export type Telemetry = (event: string, fields: Record<string, string | number | boolean | null>) => void;

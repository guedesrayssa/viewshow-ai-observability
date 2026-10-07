import type { ImportState } from "@view-show/contracts";
import type { ImportPipelineVersion, ImportRecord } from "../domain/import.js";

export interface ImportPatch {
  importId: string;
  expectedState: ImportState;
  expectedVersion: number;
  patch: Readonly<Record<string, unknown>>;
}

export interface CompletionReplayInput {
  idempotencyKey: string;
  uploadGeneration: number;
  requestedBy: string;
  parts: readonly {
    partNumber: number;
    etag: string;
    checksumSha256: string;
  }[];
}

export interface ImportRepository {
  createAndLock(
    record: ImportRecord,
    idempotencyKey: string,
  ): Promise<ImportRecord>;
  get(importId: string): Promise<ImportRecord | null>;
  /** Includes terminal records so reconciliation can recover stale locks. */
  getActive(): Promise<ImportRecord | null>;
  list(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: readonly ImportRecord[]; cursor?: string }>;
  transition(
    input: ImportPatch & { nextState: ImportState },
  ): Promise<ImportRecord>;
  reservePipeline(input: {
    importId: string;
    expectedVersion: number;
    pipelineVersion: ImportPipelineVersion;
    updatedAt: string;
  }): Promise<ImportRecord>;
  patch(input: ImportPatch): Promise<ImportRecord>;
  getCompletionReplay(
    importId: string,
    input: CompletionReplayInput,
  ): Promise<ImportRecord | null>;
  beginCompletion(
    input: ImportPatch,
    replay: CompletionReplayInput,
  ): Promise<ImportRecord>;
  recordCompletionReplay(
    importId: string,
    replay: CompletionReplayInput,
  ): Promise<ImportRecord>;
  getRestartReplay(
    importId: string,
    idempotencyKey: string,
  ): Promise<ImportRecord | null>;
  /** Consumes a losing restart key without changing the upload or record version. */
  recordRestartReplay(
    importId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ImportRecord>;
  swapUploadForRestart(
    input: ImportPatch,
    idempotencyKey: string,
  ): Promise<ImportRecord>;
  releaseTerminal(
    importId: string,
    expectedVersion: number,
    state: "READY" | "FAILED",
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ImportRecord>;
  /** Returns false if the lock has already disappeared or changed owners. */
  clearActiveLock(importId: string): Promise<boolean>;
  tryAcquireReconcileLease(input: {
    owner: string;
    nowEpochSeconds: number;
    expiresAtEpochSeconds: number;
  }): Promise<boolean>;
  releaseReconcileLease(owner: string): Promise<void>;
}

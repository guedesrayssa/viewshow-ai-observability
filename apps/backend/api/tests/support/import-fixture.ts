import { vi } from "vitest";
import { ServiceError } from "@view-show/contracts";
import { ImportUseCases } from "../../src/modules/imports/application/import-use-cases.ts";
import type { ImportRecord } from "../../src/modules/imports/domain/import.ts";
import type {
  ImportPatch,
  ImportRepository,
} from "../../src/modules/imports/ports/import-repository.ts";
import type { ImportUploadStore } from "../../src/modules/imports/ports/import-upload-store.ts";

export const checksum = "A".repeat(43) + "=";
export const startInput = {
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  requestedBy: "usr_owner",
  idempotencyKey: "start-key",
};
export function importFixture(options: { now?: () => Date } = {}) {
  let current: ImportRecord | null = null;
  let locked = false;
  let key: string | undefined;
  let uploads = 0;
  const restarts = new Set<string>();
  const completions = new Map<string, string>();
  const conflict = () => new ServiceError(409, "IMPORT_STATE_CONFLICT", "race");
  const patch = async (input: ImportPatch): Promise<ImportRecord> => {
    if (
      !current ||
      current.version !== input.expectedVersion ||
      current.state !== input.expectedState
    )
      throw conflict();
    current = { ...current, ...input.patch, version: current.version + 1 };
    return current;
  };
  const completionFingerprint = (
    id: string,
    input: {
      idempotencyKey: string;
      uploadGeneration: number;
      requestedBy: string;
      parts: readonly {
        partNumber: number;
        etag: string;
        checksumSha256: string;
      }[];
    },
  ) =>
    JSON.stringify([
      id,
      input.uploadGeneration,
      input.requestedBy,
      input.parts,
    ]);
  const completionReplay = (
    id: string,
    input: Parameters<ImportRepository["getCompletionReplay"]>[1],
  ) => {
    const key = `${id}:${input.idempotencyKey}`;
    const fingerprint = completionFingerprint(id, input);
    const existing = completions.get(key);
    if (existing !== undefined && existing !== fingerprint)
      throw new ServiceError(409, "CONFLICT", "idempotency conflict");
    return { key, fingerprint, exists: existing !== undefined };
  };
  const repository: ImportRepository = {
    async createAndLock(record, idempotencyKey) {
      if (key === idempotencyKey && current) return current;
      if (locked) throw new ServiceError(409, "IMPORT_IN_PROGRESS", "active");
      current = record;
      locked = true;
      key = idempotencyKey;
      return current;
    },
    async get(id) {
      return current?.importId === id ? current : null;
    },
    async getActive() {
      return locked ? current : null;
    },
    async list() {
      return { items: current ? [current] : [] };
    },
    async reservePipeline(input) {
      if (
        !current ||
        current.importId !== input.importId ||
        current.version !== input.expectedVersion ||
        current.pipelineVersion !== undefined
      )
        throw conflict();
      current = {
        ...current,
        pipelineVersion: input.pipelineVersion,
        updatedAt: input.updatedAt,
        version: current.version + 1,
      };
      return current;
    },
    patch,
    async getCompletionReplay(id, input) {
      const replay = completionReplay(id, input);
      return replay.exists && current?.importId === id ? current : null;
    },
    async beginCompletion(input, replayInput) {
      const replay = completionReplay(input.importId, replayInput);
      if (replay.exists && current?.importId === input.importId) return current;
      if (current?.completionRequestedAt) throw conflict();
      const updating = patch(input);
      completions.set(replay.key, replay.fingerprint);
      try {
        return await updating;
      } catch (error) {
        completions.delete(replay.key);
        throw error;
      }
    },
    async recordCompletionReplay(id, replayInput) {
      const replay = completionReplay(id, replayInput);
      if (replay.exists && current?.importId === id) return current;
      if (
        current?.importId !== id ||
        current.requestedBy !== replayInput.requestedBy ||
        current.uploadGeneration !== replayInput.uploadGeneration
      )
        throw conflict();
      completions.set(replay.key, replay.fingerprint);
      return current;
    },
    async getRestartReplay(id, key) {
      return current?.importId === id && restarts.has(key) ? current : null;
    },
    async recordRestartReplay(id, expectedVersion, key) {
      if (current?.importId !== id) throw conflict();
      if (restarts.has(key)) return current;
      if (current.version !== expectedVersion) throw conflict();
      restarts.add(key);
      return current;
    },
    async swapUploadForRestart(input, key) {
      if (restarts.has(key) || current?.completionRequestedAt) throw conflict();
      const updated = await patch(input);
      restarts.add(key);
      return updated;
    },
    async transition(input) {
      const record = await patch(input);
      current = { ...record, state: input.nextState };
      return current;
    },
    async releaseTerminal(id, version, state, fields) {
      if (!current || id !== current.importId || version !== current.version)
        throw conflict();
      current = { ...current, ...fields, state, version: version + 1 };
      locked = false;
      return current;
    },
    async clearActiveLock() {
      locked = false;
      return true;
    },
    async tryAcquireReconcileLease() {
      return true;
    },
    async releaseReconcileLease() {},
  };
  const store = {
    create: vi.fn<ImportUploadStore["create"]>(async ({ importId }) => ({
      key: `staging/imports/${importId}/source`,
      uploadId: `upload-${++uploads}`,
    })),
    signParts: vi.fn<ImportUploadStore["signParts"]>(async ({ parts }) =>
      parts.map((part) => ({
        partNumber: part.partNumber,
        url: "https://upload.test/part",
        headers: { "x-amz-checksum-sha256": part.checksumSha256 },
      })),
    ),
    listParts: vi.fn<ImportUploadStore["listParts"]>(async () => [
      {
        partNumber: 1,
        etag: "etag",
        checksumSha256: checksum,
        sizeBytes: 1024,
      },
    ]),
    getUploadedProgress: vi.fn<ImportUploadStore["getUploadedProgress"]>(
      async () => ({ completedBytes: 0 }),
    ),
    complete: vi.fn<ImportUploadStore["complete"]>(async () => ({
      versionId: "version-1",
    })),
    head: vi.fn<ImportUploadStore["head"]>(async () => ({ sizeBytes: 1024 })),
    recoverCompleted: vi.fn<ImportUploadStore["recoverCompleted"]>(
      async () => null,
    ),
    abort: vi.fn<ImportUploadStore["abort"]>(async () => {}),
  };
  return {
    repository,
    store,
    current: () => current,
    useCases: new ImportUseCases(repository, store, {
      bucket: "imports-test",
      now: options.now ?? (() => new Date("2026-09-17T10:00:00.000Z")),
    }),
  };
}

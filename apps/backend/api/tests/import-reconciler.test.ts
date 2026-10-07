import { describe, expect, it, vi } from "vitest";
import { ServiceError, type Logger } from "@view-show/contracts";
import { ImportReconciler } from "../src/modules/imports/application/import-reconciler.js";
import type { ImportRecord } from "../src/modules/imports/domain/import.js";
import type { ImportRepository } from "../src/modules/imports/ports/import-repository.js";
import type { ImportUploadStore } from "../src/modules/imports/ports/import-upload-store.js";
import type { ImportWorkerLauncher } from "../src/modules/imports/ports/import-worker-launcher.js";

const now = new Date("2026-09-17T12:00:00.000Z");
const importId = "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3";
const taskArn =
  "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/task-1";

function record(
  state: ImportRecord["state"],
  changes: Partial<ImportRecord> = {},
): ImportRecord {
  return {
    importId,
    requestedBy: "usr_owner",
    author: { id: "usr_owner", name: "Ana", email: "ana@example.test" },
    fileName: "argus_dump.sql.gz",
    sizeBytes: 1_024,
    snapshotExtractedOn: "2026-09-17",
    createdAt: "2026-09-17T11:50:00.000Z",
    updatedAt: "2026-09-17T11:50:00.000Z",
    state,
    version: 3,
    progress: { kind: "none" },
    candidateVersion: null,
    error: null,
    bucket: "private-imports",
    key: "sentinel-private-key",
    uploadId: "sentinel-private-upload-id",
    taskArn: null,
    physicalVersion: null,
    partSizeBytes: 16 * 1024 * 1024,
    expectedPartCount: 1,
    uploadGeneration: 2,
    uploadExpiresAt: "2026-09-17T12:30:00.000Z",
    ...changes,
  };
}

function setup(
  active: ImportRecord | null = null,
  canonicalFirstEnabled = false,
) {
  const reservePipeline = vi.fn(async (input) => {
    if (!active || active.version !== input.expectedVersion)
      throw new ServiceError(409, "IMPORT_STATE_CONFLICT", "race");
    active = record(active.state, {
      ...active,
      pipelineVersion: input.pipelineVersion,
      updatedAt: input.updatedAt,
      version: input.expectedVersion + 1,
    });
    return active;
  });
  const repository = {
    createAndLock: vi.fn(),
    get: vi.fn(async () => active),
    getActive: vi.fn(async () => active),
    list: vi.fn(),
    transition: vi.fn(async (input) => {
      active = record(input.nextState, {
        ...(active ?? {}),
        ...input.patch,
        state: input.nextState,
        version: input.expectedVersion + 1,
      });
      return active;
    }),
    reservePipeline,
    patch: vi.fn(async (input) =>
      record(input.expectedState, {
        ...(active ?? {}),
        ...input.patch,
        version: input.expectedVersion + 1,
      }),
    ),
    beginCompletion: vi.fn(),
    getRestartReplay: vi.fn(),
    recordRestartReplay: vi.fn(),
    swapUploadForRestart: vi.fn(),
    releaseTerminal: vi.fn(async (_id, version, state, patch) =>
      record(state, { ...(active ?? {}), ...patch, version: version + 1 }),
    ),
    clearActiveLock: vi.fn(async () => true),
    tryAcquireReconcileLease: vi.fn(async () => true),
    releaseReconcileLease: vi.fn(async () => {}),
  } satisfies ImportRepository;
  const store = {
    create: vi.fn(),
    signParts: vi.fn(),
    listParts: vi.fn(),
    complete: vi.fn(),
    head: vi.fn(),
    abort: vi.fn(async () => {}),
    recoverCompleted: vi.fn(async () => null),
  } satisfies ImportUploadStore;
  const launcher = {
    launch: vi.fn(async () => ({ taskArn })),
    status: vi.fn(async () => ({ state: "RUNNING" as const })),
  } satisfies ImportWorkerLauncher;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
  const reconciler = new ImportReconciler(repository, store, launcher, {
    owner: "api-process-a",
    now: () => now,
    logger,
    canonicalFirstEnabled,
  });
  return { reconciler, repository, reservePipeline, store, launcher, logger };
}

describe("import reconciler", () => {
  it("does no work when another API process owns the lease", async () => {
    const f = setup(record("UPLOADED"));
    f.repository.tryAcquireReconcileLease.mockResolvedValue(false);
    await f.reconciler.reconcile(now);
    expect(f.repository.tryAcquireReconcileLease).toHaveBeenCalledWith({
      owner: "api-process-a",
      nowEpochSeconds: 1_789_646_400,
      expiresAtEpochSeconds: 1_789_646_445,
    });
    expect(f.repository.getActive).not.toHaveBeenCalled();
    expect(f.repository.releaseReconcileLease).not.toHaveBeenCalled();
    expect(f.store.recoverCompleted).not.toHaveBeenCalled();
    expect(f.launcher.launch).not.toHaveBeenCalled();
  });

  it("always releases an acquired lease and preserves the primary failure", async () => {
    const failure = new Error("repository unavailable");
    const f = setup();
    f.repository.getActive.mockRejectedValue(failure);
    await expect(f.reconciler.reconcile(now)).rejects.toBe(failure);
    expect(f.repository.releaseReconcileLease).toHaveBeenCalledWith(
      "api-process-a",
    );
  });

  it("fails PREPARING at the five-minute boundary with a complete safe error", async () => {
    const active = record("PREPARING", {
      createdAt: "2026-09-17T11:55:00.000Z",
    });
    const f = setup(active);
    await f.reconciler.reconcile(now);
    expect(f.repository.releaseTerminal).toHaveBeenCalledWith(
      importId,
      3,
      "FAILED",
      {
        updatedAt: "2026-09-17T12:00:00.000Z",
        error: {
          code: "UPLOAD_PREPARATION_FAILED",
          message: "Não foi possível preparar o envio.",
          requestId: "req_import_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
        },
      },
    );
  });

  it("leaves PREPARING unchanged before five minutes", async () => {
    const f = setup(
      record("PREPARING", { createdAt: "2026-09-17T11:55:00.001Z" }),
    );
    await f.reconciler.reconcile(now);
    expect(f.repository.releaseTerminal).not.toHaveBeenCalled();
  });

  it("recovers a completed current-generation upload before considering expiry", async () => {
    const active = record("UPLOADING", {
      completionRequestedAt: "2026-09-17T11:59:00.000Z",
      completionUploadGeneration: 2,
      uploadExpiresAt: "2026-09-17T11:00:00.000Z",
    });
    const f = setup(active);
    f.store.recoverCompleted.mockResolvedValue({ versionId: "version-7" });
    await f.reconciler.reconcile(now);
    expect(f.store.recoverCompleted).toHaveBeenCalledWith(
      "sentinel-private-key",
      1_024,
    );
    expect(f.store.abort).not.toHaveBeenCalled();
    expect(f.repository.transition).toHaveBeenCalledWith({
      importId,
      expectedState: "UPLOADING",
      expectedVersion: 3,
      nextState: "UPLOADED",
      patch: {
        physicalVersion: "version-7",
        updatedAt: "2026-09-17T12:00:00.000Z",
        progress: { kind: "bytes", completedBytes: 1_024, totalBytes: 1_024 },
      },
    });
    expect(f.repository.releaseTerminal).not.toHaveBeenCalled();
  });

  it("never adopts completion evidence from another upload generation", async () => {
    const f = setup(
      record("UPLOADING", {
        completionRequestedAt: "2026-09-17T11:59:00.000Z",
        completionUploadGeneration: 1,
      }),
    );
    await f.reconciler.reconcile(now);
    expect(f.store.recoverCompleted).not.toHaveBeenCalled();
    expect(f.repository.transition).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined, "2026-09-17T11:59:00.000Z"],
    [undefined, 2, "2026-09-17T11:59:00.000Z"],
    [2, undefined, "2026-09-17T11:59:00.000Z"],
    [0, 0, "2026-09-17T11:59:00.000Z"],
    [-1, -1, "2026-09-17T11:59:00.000Z"],
    [1.5, 1.5, "2026-09-17T11:59:00.000Z"],
    [2, 3, "2026-09-17T11:59:00.000Z"],
    [2, 2, ""],
    [2, 2, "not-an-instant"],
  ] as const)(
    "fails closed for completion fence upload=%s completion=%s at=%s",
    async (uploadGeneration, completionGeneration, completionRequestedAt) => {
      const active = record("UPLOADING", { completionRequestedAt });
      if (uploadGeneration === undefined) delete active.uploadGeneration;
      else active.uploadGeneration = uploadGeneration;
      if (completionGeneration === undefined)
        delete active.completionUploadGeneration;
      else active.completionUploadGeneration = completionGeneration;
      const f = setup(active);
      f.store.recoverCompleted.mockResolvedValue({ versionId: "version-bad" });

      await f.reconciler.reconcile(now);

      expect(f.store.recoverCompleted).not.toHaveBeenCalled();
      expect(f.repository.transition).not.toHaveBeenCalled();
    },
  );

  it("emits a stable numeric upload-age event without physical identifiers", async () => {
    const f = setup(record("UPLOADING"));
    await f.reconciler.reconcile(now);
    expect(f.logger.info).toHaveBeenCalledWith("import active upload age", {
      event: "import_active_upload_age",
      active_upload_age_seconds: 600,
      state: "UPLOADING",
    });
    const serialized = JSON.stringify(f.logger.info.mock.calls);
    expect(serialized).not.toContain("sentinel-private-key");
    expect(serialized).not.toContain("sentinel-private-upload-id");
    expect(serialized).not.toContain("https://");
  });

  it("propagates recovery infrastructure errors without aborting or expiring", async () => {
    const active = record("UPLOADING", {
      completionRequestedAt: "2026-09-17T11:59:00.000Z",
      completionUploadGeneration: 2,
      uploadExpiresAt: "2026-09-17T11:00:00.000Z",
    });
    const f = setup(active);
    const failure = new Error("S3 denied sentinel-private-key");
    f.store.recoverCompleted.mockRejectedValue(failure);
    await expect(f.reconciler.reconcile(now)).rejects.toBe(failure);
    expect(f.store.abort).not.toHaveBeenCalled();
    expect(f.repository.releaseTerminal).not.toHaveBeenCalled();
  });

  it("expires an upload after absent recovery and treats abort as best effort", async () => {
    const active = record("UPLOADING", {
      completionRequestedAt: "2026-09-17T11:59:00.000Z",
      completionUploadGeneration: 2,
      uploadExpiresAt: "2026-09-17T12:00:00.000Z",
    });
    const f = setup(active);
    f.store.abort.mockRejectedValue(new Error("S3 unavailable"));
    await f.reconciler.reconcile(now);
    expect(f.store.abort).toHaveBeenCalledWith(
      "sentinel-private-key",
      "sentinel-private-upload-id",
    );
    expect(f.repository.releaseTerminal).toHaveBeenCalledWith(
      importId,
      3,
      "FAILED",
      {
        updatedAt: "2026-09-17T12:00:00.000Z",
        error: {
          code: "UPLOAD_EXPIRED",
          message: "O prazo de envio expirou.",
          requestId: "req_import_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
        },
      },
    );
  });

  it("launches an UPLOADED import once and stores the task ARN with CAS", async () => {
    const f = setup(record("UPLOADED"));
    await f.reconciler.reconcile(now);
    expect(f.launcher.launch).toHaveBeenCalledWith(importId, "legacy-v1");
    expect(f.repository.patch).toHaveBeenCalledWith({
      importId,
      expectedState: "UPLOADED",
      expectedVersion: 4,
      patch: {
        taskArn,
        updatedAt: "2026-09-17T12:00:00.000Z",
      },
    });
  });

  it("reserves the canonical pipeline before launching a newly uploaded import", async () => {
    const f = setup(record("UPLOADED"), true);

    await f.reconciler.reconcile(now);

    expect(f.reservePipeline).toHaveBeenCalledWith({
      importId,
      expectedVersion: 3,
      pipelineVersion: "canonical-v2",
      updatedAt: "2026-09-17T12:00:00.000Z",
    });
    expect(f.launcher.launch).toHaveBeenCalledWith(importId, "canonical-v2");
    expect(f.repository.patch).toHaveBeenCalledWith({
      importId,
      expectedState: "UPLOADED",
      expectedVersion: 4,
      patch: {
        taskArn,
        updatedAt: "2026-09-17T12:00:00.000Z",
      },
    });
  });

  it("uses the current flag only when an unstarted import reaches its first reservation", async () => {
    const f = setup(record("UPLOADED"));
    const afterFlagChange = new ImportReconciler(
      f.repository,
      f.store,
      f.launcher,
      {
        owner: "api-process-b",
        now: () => now,
        logger: f.logger,
        canonicalFirstEnabled: true,
      },
    );

    await afterFlagChange.reconcile(now);

    expect(f.reservePipeline).toHaveBeenCalledWith({
      importId,
      expectedVersion: 3,
      pipelineVersion: "canonical-v2",
      updatedAt: "2026-09-17T12:00:00.000Z",
    });
  });

  it("keeps the reserved pipeline when the canonical-first flag changes before retry", async () => {
    const f = setup(record("UPLOADED"), true);
    const launchFailure = new Error("worker launch unavailable");
    f.launcher.launch.mockRejectedValueOnce(launchFailure);

    await expect(f.reconciler.reconcile(now)).rejects.toBe(launchFailure);

    const retry = new ImportReconciler(f.repository, f.store, f.launcher, {
      owner: "api-process-b",
      now: () => now,
      logger: f.logger,
      canonicalFirstEnabled: false,
    });
    await retry.reconcile(now);

    expect(f.reservePipeline).toHaveBeenCalledTimes(1);
    expect(f.launcher.launch).toHaveBeenLastCalledWith(
      importId,
      "canonical-v2",
    );
  });

  it("continues reconciling a legacy processing import without a pipeline version", async () => {
    const f = setup(record("PROCESSING", { taskArn }));
    f.launcher.status.mockResolvedValue({ state: "RUNNING" });

    await f.reconciler.reconcile(now);

    expect(f.launcher.status).toHaveBeenCalledWith(taskArn);
    expect(f.reservePipeline).not.toHaveBeenCalled();
  });

  it("launches an untracked legacy processing import with legacy-v1 despite the current flag", async () => {
    const f = setup(record("PROCESSING"), true);

    await f.reconciler.reconcile(now);

    expect(f.reservePipeline).not.toHaveBeenCalled();
    expect(f.launcher.launch).toHaveBeenCalledWith(importId, "legacy-v1");
    expect(f.repository.patch).toHaveBeenCalledWith({
      importId,
      expectedState: "PROCESSING",
      expectedVersion: 3,
      patch: {
        taskArn,
        updatedAt: "2026-09-17T12:00:00.000Z",
      },
    });
  });

  it("replays launch after the worker wins the state race and patches the same ARN", async () => {
    const uploaded = record("UPLOADED");
    const validating = record("VALIDATING", {
      version: 4,
      pipelineVersion: "legacy-v1",
    });
    const f = setup(uploaded);
    f.repository.getActive
      .mockResolvedValueOnce(uploaded)
      .mockResolvedValueOnce(validating);
    f.repository.patch
      .mockRejectedValueOnce(
        new ServiceError(409, "IMPORT_STATE_CONFLICT", "race"),
      )
      .mockResolvedValueOnce(record("VALIDATING", { version: 5, taskArn }));

    await expect(f.reconciler.reconcile(now)).rejects.toMatchObject({
      code: "IMPORT_STATE_CONFLICT",
    });
    await f.reconciler.reconcile(now);
    expect(f.launcher.launch).toHaveBeenNthCalledWith(1, importId, "legacy-v1");
    expect(f.launcher.launch).toHaveBeenNthCalledWith(2, importId, "legacy-v1");
    expect(f.repository.patch).toHaveBeenLastCalledWith({
      importId,
      expectedState: "VALIDATING",
      expectedVersion: 4,
      patch: { taskArn, updatedAt: "2026-09-17T12:00:00.000Z" },
    });
  });

  it.each(["PENDING", "RUNNING"] as const)(
    "observes %s without launching or mutating",
    async (state) => {
      const f = setup(record("PROCESSING", { taskArn }));
      f.launcher.status.mockResolvedValue({ state });
      await f.reconciler.reconcile(now);
      expect(f.launcher.status).toHaveBeenCalledWith(taskArn);
      expect(f.launcher.launch).not.toHaveBeenCalled();
      expect(f.repository.patch).not.toHaveBeenCalled();
      expect(f.repository.releaseTerminal).not.toHaveBeenCalled();
    },
  );

  it.each([17, 0, undefined])(
    "fails a still-active import when ECS is STOPPED with exit code %s",
    async (exitCode) => {
      const active = record("PROCESSING", { taskArn });
      const f = setup(active);
      f.launcher.status.mockResolvedValue({
        state: "STOPPED",
        ...(exitCode === undefined ? {} : { exitCode }),
      });
      f.repository.get.mockResolvedValue(active);
      await f.reconciler.reconcile(now);
      expect(f.repository.releaseTerminal).toHaveBeenCalledWith(
        importId,
        3,
        "FAILED",
        {
          updatedAt: "2026-09-17T12:00:00.000Z",
          error: {
            code: "WORKER_STOPPED",
            message: "O processamento foi interrompido antes de concluir.",
            requestId: "req_import_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
            retryable: true,
          },
        },
      );
    },
  );

  it("only clears the matching stale lock if the worker finished concurrently", async () => {
    const f = setup(record("PROCESSING", { taskArn }));
    f.launcher.status.mockResolvedValue({ state: "STOPPED", exitCode: 0 });
    f.repository.get.mockResolvedValue(record("READY", { version: 4 }));
    await f.reconciler.reconcile(now);
    expect(f.repository.clearActiveLock).toHaveBeenCalledWith(importId);
    expect(f.repository.releaseTerminal).not.toHaveBeenCalled();
  });

  it.each(["READY", "FAILED"] as const)(
    "only clears a stale lock for an initially terminal %s import",
    async (state) => {
      const f = setup(record(state));
      await f.reconciler.reconcile(now);
      expect(f.repository.clearActiveLock).toHaveBeenCalledWith(importId);
      expect(f.launcher.launch).not.toHaveBeenCalled();
      expect(f.store.abort).not.toHaveBeenCalled();
    },
  );

  it("starts immediately, schedules at 60 seconds, unrefs, stops once and sanitizes failures", async () => {
    const f = setup();
    const sentinel = "sentinel-private-upload-id";
    const sentinelKey = "sentinel-private-key";
    const sentinelUrl = "https://signed.test";
    f.repository.tryAcquireReconcileLease.mockRejectedValue(
      Object.assign(new Error(sentinelUrl), {
        name: sentinelKey,
        cause: { nested: sentinel, url: sentinelUrl },
      }),
    );
    const unref = vi.fn();
    const handle = { unref };
    let tick: (() => void) | undefined;
    const setIntervalFn = vi.fn(
      (callback: () => void, milliseconds: number) => {
        tick = callback;
        expect(milliseconds).toBe(60_000);
        return handle;
      },
    );
    const clearIntervalFn = vi.fn();
    const reconciler = new ImportReconciler(f.repository, f.store, f.launcher, {
      owner: "api-process-a",
      now: () => now,
      logger: f.logger,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    reconciler.start();
    await reconciler.stop();
    await reconciler.stop();
    reconciler.start();
    tick?.();
    await Promise.resolve();

    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(f.repository.tryAcquireReconcileLease).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      "import reconciliation failed",
      { event: "import_reconciliation_failed", error_name: "ERROR" },
    );
    const logged = JSON.stringify(f.logger.error.mock.calls);
    expect(logged).not.toContain(sentinel);
    expect(logged).not.toContain(sentinelKey);
    expect(logged).not.toContain(sentinelUrl);
  });

  it.each([
    [
      Object.assign(new Error("sdk"), { $metadata: { httpStatusCode: 500 } }),
      "AWS_ERROR",
    ],
    [new TypeError("bad input"), "ERROR"],
    [
      { name: "sentinel-private-key", message: "https://signed.test" },
      "UNKNOWN",
    ],
  ] as const)(
    "logs only the closed failure category %s",
    async (failure, category) => {
      const f = setup();
      f.repository.tryAcquireReconcileLease.mockRejectedValue(failure);
      f.reconciler.start();
      await f.reconciler.stop();
      expect(f.logger.error).toHaveBeenCalledWith(
        "import reconciliation failed",
        { event: "import_reconciliation_failed", error_name: category },
      );
    },
  );
});

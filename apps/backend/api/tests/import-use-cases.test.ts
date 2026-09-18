import { describe, expect, it, vi } from "vitest";
import {
  errorCodeSchema,
  importSnapshotSchema,
  ServiceError,
} from "@view-show/contracts";
import {
  importFixture,
  startInput,
  checksum,
} from "./support/import-fixture.ts";

describe("durable import use cases", () => {
  it("consumes the losing distinct restart key, including replay after a later restart", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "winner",
    };
    const losing = { ...input, idempotencyKey: "loser" };
    const results = await Promise.all([
      f.useCases.restart(input),
      f.useCases.restart(losing),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.current()?.uploadGeneration).toBe(2);
    await f.useCases.restart(losing);
    expect(f.current()?.uploadGeneration).toBe(2);
    await f.useCases.restart({ ...input, idempotencyKey: "later" });
    await f.useCases.restart(losing);
    expect(f.current()?.uploadGeneration).toBe(3);
    expect(f.store.create).toHaveBeenCalledTimes(4);
  });
  it("does not report successful losing restart when its replay cannot be persisted", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    vi.spyOn(f.repository, "swapUploadForRestart").mockRejectedValueOnce(
      new ServiceError(409, "IMPORT_STATE_CONFLICT", "race"),
    );
    vi.spyOn(f.repository, "recordRestartReplay").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      f.useCases.restart({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "loser",
      }),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(f.current()?.uploadGeneration).toBe(1);
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-2");
  });
  it("preserves a committed start when its write response and confirmation read are lost", async () => {
    const f = importFixture();
    const transition = f.repository.transition.bind(f.repository);
    vi.spyOn(f.repository, "transition").mockImplementationOnce(
      async (input) => {
        await transition(input);
        throw new Error("write response lost");
      },
    );
    vi.spyOn(f.repository, "get").mockRejectedValueOnce(
      new Error("read unavailable"),
    );
    await expect(f.useCases.start(startInput)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.current()).toMatchObject({
      state: "UPLOADING",
      uploadId: "upload-1",
    });
    expect(f.store.abort).not.toHaveBeenCalled();
    expect(await f.useCases.start(startInput)).toMatchObject({
      data: { state: "UPLOADING" },
    });
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it("fences a failed start durably before aborting its upload", async () => {
    const f = importFixture();
    vi.spyOn(f.repository, "transition").mockRejectedValueOnce(
      new Error("write unavailable"),
    );
    let stateAtAbort: string | undefined;
    f.store.abort.mockImplementationOnce(async () => {
      stateAtAbort = f.current()?.state;
    });
    await expect(f.useCases.start(startInput)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.store.abort).toHaveBeenCalledTimes(1);
    expect(stateAtAbort).toBe("FAILED");
  });
  it("preserves an ambiguous start when terminalization cannot fence its write", async () => {
    const f = importFixture();
    vi.spyOn(f.repository, "transition").mockRejectedValueOnce(
      new Error("write may still commit"),
    );
    vi.spyOn(f.repository, "releaseTerminal").mockRejectedValueOnce(
      new Error("fence unavailable"),
    );
    await expect(f.useCases.start(startInput)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.store.abort).not.toHaveBeenCalled();
  });
  it("preserves a committed restart when its write response and confirmation read are lost", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const swap = f.repository.swapUploadForRestart.bind(f.repository);
    vi.spyOn(f.repository, "swapUploadForRestart").mockImplementationOnce(
      async (...args) => {
        await swap(...args);
        vi.spyOn(f.repository, "get").mockRejectedValueOnce(
          new Error("read unavailable"),
        );
        throw new Error("write response lost");
      },
    );
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "lost-restart",
    };
    await expect(f.useCases.restart(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.current()).toMatchObject({
      uploadId: "upload-2",
      uploadGeneration: 2,
    });
    expect(f.store.abort).not.toHaveBeenCalled();
    await f.useCases.restart(input);
    expect(f.store.create).toHaveBeenCalledTimes(2);
  });
  it("preserves an ambiguous restart while the unchanged version could still adopt it", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    vi.spyOn(f.repository, "swapUploadForRestart").mockRejectedValueOnce(
      new Error("write may still commit"),
    );
    await expect(
      f.useCases.restart({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "pending",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.store.abort).not.toHaveBeenCalled();
  });
  it("aborts a replacement when completion intent wins the restart race", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    let entered!: () => void;
    let release!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.store.create.mockImplementationOnce(async () => {
      entered();
      await continueCreate;
      return { key: f.current()!.key, uploadId: "race-replacement" };
    });
    const restart = f.useCases.restart({
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "restart-race",
    });
    await creating;
    f.store.complete.mockRejectedValueOnce(
      new Error("transient upload failure"),
    );
    await expect(
      f.useCases.complete({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "complete-race",
        parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
      }),
    ).rejects.toMatchObject({ status: 503 });
    release();
    expect(await restart).toMatchObject({ data: { state: "UPLOADING" } });
    expect(f.current()).toMatchObject({
      uploadId: "upload-1",
      completionUploadGeneration: 1,
    });
    expect(f.store.abort).toHaveBeenCalledWith(
      f.current()?.key,
      "race-replacement",
    );
  });
  it("does not complete stale multipart coordinates when restart wins the intent race", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    let entered!: () => void;
    let release!: () => void;
    const reserving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueIntent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begin = f.repository.beginCompletion.bind(f.repository);
    vi.spyOn(f.repository, "beginCompletion").mockImplementationOnce(
      async (...args) => {
        entered();
        await continueIntent;
        return begin(...args);
      },
    );
    const complete = f.useCases.complete({
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-race",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    });
    await reserving;
    await f.useCases.restart({
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "restart-race",
    });
    release();
    await expect(complete).rejects.toMatchObject({
      code: "IMPORT_STATE_CONFLICT",
    });
    expect(f.current()).toMatchObject({
      uploadId: "upload-2",
      uploadGeneration: 2,
    });
    expect(f.current()).not.toHaveProperty("completionRequestedAt");
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("recovers a completed object after the process loses completion persistence", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-crash",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    vi.spyOn(f.repository, "transition").mockRejectedValueOnce(
      new Error("database response lost before persistence"),
    );
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.current()).toMatchObject({
      state: "UPLOADING",
      completionRequestedAt: "2026-09-17T10:00:00.000Z",
      completionUploadGeneration: 1,
    });
    f.store.recoverCompleted.mockResolvedValue({ versionId: "version-1" });
    expect(await f.useCases.complete(input)).toMatchObject({
      data: { state: "UPLOADED" },
    });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
    expect(f.store.recoverCompleted).toHaveBeenCalledWith(
      f.current()?.key,
      1024,
    );
    expect(f.current()?.physicalVersion).toBe("version-1");
  });
  it("retries the same multipart if completion intent exists but no object exists", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-retry",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    f.store.complete.mockRejectedValueOnce(new Error("transient S3 outage"));
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(await f.useCases.complete(input)).toMatchObject({
      data: { state: "UPLOADED" },
    });
    expect(f.store.complete).toHaveBeenCalledTimes(2);
  });
  it("prevents restart after completion intent and does not recover arbitrary S3 errors", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-error",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    f.store.complete.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.store.recoverCompleted).not.toHaveBeenCalled();
    await expect(
      f.useCases.restart({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "restart-blocked",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it("recovers only NoSuchUpload after the completion intent is durable", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    f.store.complete.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "NoSuchUpload" }),
    );
    f.store.recoverCompleted.mockResolvedValueOnce({
      versionId: "recovered-version",
    });
    expect(
      await f.useCases.complete({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "complete-recover",
        parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
      }),
    ).toMatchObject({ data: { state: "UPLOADED" } });
    expect(f.current()?.physicalVersion).toBe("recovered-version");
  });
  it("has a public safe code for preparation failures", () => {
    expect(errorCodeSchema.safeParse("UPLOAD_PREPARATION_FAILED").success).toBe(
      true,
    );
  });
  it("starts under lock, persists geometry, and replays without another upload", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    expect(importSnapshotSchema.parse(started.data)).toMatchObject({
      state: "UPLOADING",
      requestedBy: "usr_owner",
      canManageUpload: true,
    });
    expect(f.current()).toMatchObject({
      uploadId: "upload-1",
      partSizeBytes: 16777216,
      expectedPartCount: 1,
      uploadGeneration: 1,
      uploadExpiresAt: "2026-09-18T10:00:00.000Z",
    });
    expect(await f.useCases.start(startInput)).toEqual(started);
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it("terminalizes S3 preparation failure and releases the lock", async () => {
    const f = importFixture();
    f.store.create.mockRejectedValue(new Error("secret bucket"));
    await expect(f.useCases.start(startInput)).rejects.toMatchObject({
      code: "UPLOAD_PREPARATION_FAILED",
      status: 503,
    });
    expect(f.current()).toMatchObject({
      state: "FAILED",
      error: {
        code: "UPLOAD_PREPARATION_FAILED",
        requestId: "req_import_" + f.current()!.importId.slice(4),
      },
    });
    expect(await f.repository.getActive()).toBeNull();
  });
  it("aborts the new upload when preparation persistence fails", async () => {
    const f = importFixture();
    vi.spyOn(f.repository, "transition").mockRejectedValueOnce(
      new Error("database down"),
    );
    await expect(f.useCases.start(startInput)).rejects.toMatchObject({
      code: "UPLOAD_PREPARATION_FAILED",
    });
    expect(f.store.abort).toHaveBeenCalledWith(expect.any(String), "upload-1");
    expect(f.current()?.state).toBe("FAILED");
  });
  it("permits shared reads, derives permissions and withholds physical fields", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    expect(
      await f.useCases.get(started.data.importId, "usr_other"),
    ).toMatchObject({
      data: { canManageUpload: false },
    });
    const page = await f.useCases.list({ limit: 50, requestedBy: "usr_other" });
    expect(page.data).toMatchObject({
      items: [{ importId: started.data.importId, canManageUpload: false }],
      cursor: null,
    });
    expect(JSON.stringify(page)).not.toMatch(
      /uploadId|bucket|physicalVersion|restartKey/,
    );
  });
  it("shows the same S3-confirmed progress to owner and non-owner without physical evidence", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    f.store.getUploadedProgress.mockResolvedValue({ completedBytes: 640 });

    const owner = await f.useCases.get(started.data.importId, "usr_owner");
    const reader = await f.useCases.get(started.data.importId, "usr_reader");

    expect(owner.data.progress).toEqual({
      kind: "bytes",
      completedBytes: 640,
      totalBytes: 1024,
    });
    expect(reader.data.progress).toEqual(owner.data.progress);
    expect(reader.data.canManageUpload).toBe(false);
    expect(JSON.stringify(reader.data)).not.toMatch(
      /uploadId|bucket|\bkey\b|etag|checksum|url/i,
    );
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(1);
    expect(f.store.getUploadedProgress).toHaveBeenCalledWith({
      key: f.current()?.key,
      uploadId: "upload-1",
      expectedSizeBytes: 1024,
      expectedPartCount: 1,
      expectedPartSizeBytes: 16777216,
    });
  });
  it("enriches at most the one uploading item in a large page and preserves order and cursor", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    const active = f.current()!;
    const records = Array.from({ length: 100 }, (_, index) =>
      index === 63
        ? active
        : {
            ...active,
            importId: `terminal-${index}`,
            state: "READY" as const,
            progress: { kind: "none" as const },
          },
    );
    vi.spyOn(f.repository, "list").mockResolvedValue({
      items: records,
      cursor: "next-page",
    });
    f.store.getUploadedProgress.mockResolvedValue({ completedBytes: 512 });

    const page = await f.useCases.list({ limit: 100, requestedBy: "reader" });

    expect(page.data.items.map((item) => item.importId)).toEqual(
      records.map((item) => item.importId),
    );
    expect(page.data.items[63]?.progress).toEqual({
      kind: "bytes",
      completedBytes: 512,
      totalBytes: 1024,
    });
    expect(page.data.cursor).toBe("next-page");
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent reads, caches briefly and never reuses another upload generation", async () => {
    let now = new Date("2026-09-17T10:00:00.000Z");
    const f = importFixture({ now: () => now });
    const started = await f.useCases.start(startInput);
    let release!: (value: { completedBytes: number }) => void;
    f.store.getUploadedProgress.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = f.useCases.get(started.data.importId, "owner");
    const concurrent = f.useCases.list({ limit: 50, requestedBy: "reader" });
    await vi.waitFor(() =>
      expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(1),
    );
    release({ completedBytes: 256 });
    await expect(first).resolves.toMatchObject({
      data: { progress: { completedBytes: 256 } },
    });
    await expect(concurrent).resolves.toMatchObject({
      data: { items: [{ progress: { completedBytes: 256 } }] },
    });
    await f.useCases.get(started.data.importId, "reader");
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(1);

    await f.useCases.restart({
      importId: started.data.importId,
      requestedBy: "usr_owner",
      idempotencyKey: "new-generation",
    });
    f.store.getUploadedProgress.mockResolvedValue({ completedBytes: 128 });
    await f.useCases.get(started.data.importId, "reader");
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(2);

    now = new Date("2026-09-17T10:00:06.000Z");
    f.store.getUploadedProgress.mockResolvedValue({ completedBytes: 384 });
    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 384 } },
    });
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(3);
  });
  it("never reuses cached progress for another physical upload in the same generation", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    const initial = f.current()!;
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 256 });
    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 256 } },
    });

    const replacement = { ...initial, uploadId: "upload-replacement" };
    vi.spyOn(f.repository, "get").mockResolvedValue(replacement);
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 128 });

    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 128 } },
    });
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(2);
    expect(f.store.getUploadedProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ uploadId: "upload-replacement" }),
    );
  });
  it("never shares an in-flight progress lookup with another physical upload", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    const initial = f.current()!;
    let releaseInitial!: (value: { completedBytes: number }) => void;
    f.store.getUploadedProgress
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({ completedBytes: 128 });

    const initialRead = f.useCases.get(started.data.importId, "reader");
    await vi.waitFor(() =>
      expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(1),
    );
    vi.spyOn(f.repository, "get").mockResolvedValue({
      ...initial,
      uploadId: "upload-replacement",
    });

    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 128 } },
    });
    releaseInitial({ completedBytes: 256 });
    await expect(initialRead).resolves.toMatchObject({
      data: { progress: { completedBytes: 256 } },
    });
    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 128 } },
    });
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(2);
  });
  it("never uses stale progress from another physical upload", async () => {
    let now = new Date("2026-09-17T10:00:00.000Z");
    const f = importFixture({ now: () => now });
    const started = await f.useCases.start(startInput);
    const initial = f.current()!;
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 256 });
    await f.useCases.get(started.data.importId, "reader");
    now = new Date("2026-09-17T10:00:06.000Z");
    vi.spyOn(f.repository, "get").mockResolvedValue({
      ...initial,
      uploadId: "upload-replacement",
    });
    f.store.getUploadedProgress.mockRejectedValueOnce(new Error("s3 down"));

    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(f.store.getUploadedProgress).toHaveBeenCalledTimes(2);
  });
  it("uses only same-generation stale progress on transient failure and otherwise fails safely", async () => {
    let now = new Date("2026-09-17T10:00:00.000Z");
    const f = importFixture({ now: () => now });
    const started = await f.useCases.start(startInput);
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 320 });
    await f.useCases.get(started.data.importId, "reader");
    now = new Date("2026-09-17T10:00:06.000Z");
    f.store.getUploadedProgress.mockRejectedValueOnce(new Error("s3 down"));
    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).resolves.toMatchObject({
      data: { progress: { completedBytes: 320 } },
    });

    await f.useCases.restart({
      importId: started.data.importId,
      requestedBy: "usr_owner",
      idempotencyKey: "fresh-generation",
    });
    f.store.getUploadedProgress.mockRejectedValueOnce(new Error("s3 down"));
    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
  });
  it("does not query S3 progress for non-uploading states", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    const record = f.current()!;
    vi.spyOn(f.repository, "get").mockResolvedValue({
      ...record,
      state: "UPLOADED",
    });
    vi.spyOn(f.repository, "list").mockResolvedValue({
      items: [{ ...record, state: "READY" }],
    });

    await f.useCases.get(started.data.importId, "reader");
    await f.useCases.list({ limit: 50, requestedBy: "reader" });

    expect(f.store.getUploadedProgress).not.toHaveBeenCalled();
  });
  it("fails before S3 when an uploading record has incomplete internal geometry", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    vi.spyOn(f.repository, "get").mockResolvedValue({
      ...f.current()!,
      uploadId: null,
    });

    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(f.store.getUploadedProgress).not.toHaveBeenCalled();
  });
  it("fails closed when fresh physical evidence regresses below cached progress", async () => {
    let now = new Date("2026-09-17T10:00:00.000Z");
    const f = importFixture({ now: () => now });
    const started = await f.useCases.start(startInput);
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 640 });
    await f.useCases.get(started.data.importId, "reader");
    now = new Date("2026-09-17T10:00:06.000Z");
    f.store.getUploadedProgress.mockResolvedValueOnce({ completedBytes: 320 });

    await expect(
      f.useCases.get(started.data.importId, "reader"),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
  });
  it.each([-1, 1025, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe physical progress %s instead of clamping or inventing zero",
    async (completedBytes) => {
      const f = importFixture();
      const started = await f.useCases.start(startInput);
      f.store.getUploadedProgress.mockResolvedValue({ completedBytes });
      await expect(
        f.useCases.get(started.data.importId, "reader"),
      ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    },
  );
  it("reports the public active import ID on contested start", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    await expect(
      f.useCases.start({ ...startInput, idempotencyKey: "different" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "IMPORT_IN_PROGRESS",
      details: { importId: started.data.importId },
    });
  });
  it("denies every upload operation to another viewer", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_other",
      idempotencyKey: "action-key",
      parts: [{ partNumber: 1, checksumSha256: checksum, etag: "etag" }],
    };
    for (const operation of [
      () => f.useCases.signParts(input),
      () => f.useCases.listParts(importId, input.requestedBy),
      () => f.useCases.restart(input),
      () => f.useCases.complete(input),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 403,
        code: "IMPORT_NOT_OWNED",
      });
    }
  });
  it("signs persisted coordinates with expiry and returns S3 parts", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const signed = await f.useCases.signParts({
      importId,
      requestedBy: "usr_owner",
      parts: [{ partNumber: 1, checksumSha256: checksum }],
    });
    expect(signed.data.parts[0]).toMatchObject({
      partNumber: 1,
      expiresAt: "2026-09-17T10:15:00.000Z",
      headers: { "x-amz-checksum-sha256": checksum },
    });
    expect(f.store.signParts).toHaveBeenCalledWith({
      key: f.current()?.key,
      uploadId: "upload-1",
      parts: [{ partNumber: 1, checksumSha256: checksum }],
    });
    expect(await f.useCases.listParts(importId, "usr_owner")).toMatchObject({
      data: { parts: [{ partNumber: 1, sizeBytes: 1024 }] },
    });
  });
  it.each([
    { numbers: [2] },
    { numbers: [1, 1] },
    { numbers: [2, 1] },
    { numbers: Array.from({ length: 21 }, (_, i) => i + 1) },
  ])("rejects invalid signing numbers $numbers", async ({ numbers }) => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    await expect(
      f.useCases.signParts({
        importId,
        requestedBy: "usr_owner",
        parts: numbers.map((partNumber) => ({
          partNumber,
          checksumSha256: checksum,
        })),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.store.signParts).not.toHaveBeenCalled();
  });
  it("restarts once per idempotency key, including replay after another restart", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "restart-a",
    };
    await f.useCases.restart(input);
    expect(f.current()).toMatchObject({
      uploadId: "upload-2",
      uploadGeneration: 2,
    });
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-1");
    await f.useCases.restart(input);
    await f.useCases.restart({ ...input, idempotencyKey: "restart-b" });
    await f.useCases.restart(input);
    expect(f.store.create).toHaveBeenCalledTimes(3);
    expect(f.current()?.uploadGeneration).toBe(3);
  });
  it("keeps the original absolute 24-hour upload expiry across restarts", async () => {
    let now = new Date("2026-09-17T10:00:00.000Z");
    const f = importFixture({ now: () => now });
    const started = await f.useCases.start(startInput);
    const originalExpiry = f.current()?.uploadExpiresAt;

    now = new Date("2026-09-18T09:00:00.000Z");
    await f.useCases.restart({
      importId: started.data.importId,
      requestedBy: "usr_owner",
      idempotencyKey: "restart-near-expiry",
    });

    expect(originalExpiry).toBe("2026-09-18T10:00:00.000Z");
    expect(f.current()?.uploadExpiresAt).toBe(originalExpiry);
  });
  it("aborts a losing replacement and returns the current record", async () => {
    const f = importFixture();
    const started = await f.useCases.start(startInput);
    vi.spyOn(f.repository, "swapUploadForRestart").mockRejectedValueOnce(
      new ServiceError(409, "IMPORT_STATE_CONFLICT", "race"),
    );
    expect(
      await f.useCases.restart({
        importId: started.data.importId,
        requestedBy: "usr_owner",
        idempotencyKey: "restart",
      }),
    ).toEqual(started);
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-2");
    expect(f.current()?.uploadId).toBe("upload-1");
  });
  it("finishes old-upload cleanup after a committed restart loses its write response", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const swap = f.repository.swapUploadForRestart.bind(f.repository);
    vi.spyOn(f.repository, "swapUploadForRestart").mockImplementationOnce(
      async (...args) => {
        await swap(...args);
        throw new Error("response lost");
      },
    );
    expect(
      await f.useCases.restart({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "restart-lost",
      }),
    ).toMatchObject({ data: { state: "UPLOADING" } });
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-1");
    expect(f.store.abort).not.toHaveBeenCalledWith(
      f.current()?.key,
      "upload-2",
    );
  });
  it("returns IMPORT_NOT_FOUND for missing public import IDs", async () => {
    const f = importFixture();
    await expect(
      f.useCases.get("imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3", "usr_owner"),
    ).rejects.toMatchObject({ status: 404, code: "IMPORT_NOT_FOUND" });
  });
  it("completes with geometry and versioned HEAD, then replays without S3", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-key",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    expect(await f.useCases.complete(input)).toMatchObject({
      data: { state: "UPLOADED" },
    });
    expect(f.store.complete).toHaveBeenCalledWith({
      key: f.current()?.key,
      uploadId: "upload-1",
      parts: input.parts,
      expectedSizeBytes: 1024,
      expectedPartCount: 1,
    });
    expect(f.store.head).toHaveBeenCalledWith(
      f.current()?.key,
      "version-1",
      1024,
    );
    expect(f.current()?.physicalVersion).toBe("version-1");
    await f.useCases.complete(input);
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("rejects reuse of a completion key with another manifest", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-bound-manifest",
      parts: [{ partNumber: 1, etag: "etag-a", checksumSha256: checksum }],
    };
    await f.useCases.complete(input);

    await expect(
      f.useCases.complete({
        ...input,
        parts: [
          {
            partNumber: 1,
            etag: "etag-b",
            checksumSha256: checksum,
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("binds a completion key to its owner and upload generation", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-bound-context",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await f.useCases.complete(input);

    await expect(
      f.useCases.complete({ ...input, requestedBy: "usr_other" }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    vi.spyOn(f.repository, "get").mockResolvedValue({
      ...f.current()!,
      uploadGeneration: 2,
    });
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
  });
  it("records a new completion key after success without repeating S3", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const base = {
      importId,
      requestedBy: "usr_owner",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await f.useCases.complete({ ...base, idempotencyKey: "complete-first" });
    await expect(
      f.useCases.complete({ ...base, idempotencyKey: "complete-later" }),
    ).resolves.toMatchObject({ data: { state: "UPLOADED" } });
    await expect(
      f.useCases.complete({
        ...base,
        idempotencyKey: "complete-later",
        parts: [{ ...base.parts[0], etag: "different" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("replays a matching completion key after the worker reaches FAILED", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-before-failed",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await f.useCases.complete(input);
    await f.repository.releaseTerminal(
      importId,
      f.current()!.version,
      "FAILED",
      {
        error: {
          code: "WORKER_STOPPED",
          message: "A importação falhou durante o processamento.",
          requestId: "req_failed_completion",
        },
      },
    );

    await expect(f.useCases.complete(input)).resolves.toMatchObject({
      data: { state: "FAILED" },
    });
    await expect(
      f.useCases.complete({
        ...input,
        parts: [{ ...input.parts[0], etag: "different" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("records a new completion key on FAILED only for the owner", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const base = {
      importId,
      requestedBy: "usr_owner",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await f.useCases.complete({
      ...base,
      idempotencyKey: "complete-before-failed",
    });
    await f.repository.releaseTerminal(
      importId,
      f.current()!.version,
      "FAILED",
      {
        error: {
          code: "WORKER_STOPPED",
          message: "A importação falhou durante o processamento.",
          requestId: "req_failed_completion",
        },
      },
    );

    const later = { ...base, idempotencyKey: "complete-after-failed" };
    await expect(f.useCases.complete(later)).resolves.toMatchObject({
      data: { state: "FAILED" },
    });
    await expect(
      f.useCases.complete({ ...later, requestedBy: "usr_other" }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(
      f.useCases.complete({
        ...base,
        requestedBy: "usr_other",
        idempotencyKey: "complete-after-failed-other",
      }),
    ).rejects.toMatchObject({ status: 403, code: "IMPORT_NOT_OWNED" });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("does not adopt a completion key when FAILED predates completion intent", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    await f.repository.releaseTerminal(
      importId,
      f.current()!.version,
      "FAILED",
      {
        error: {
          code: "UPLOAD_EXPIRED",
          message: "O prazo para envio expirou.",
          requestId: "req_failed_before_completion",
        },
      },
    );

    await expect(
      f.useCases.complete({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "complete-after-early-failure",
        parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "IMPORT_STATE_CONFLICT",
    });
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("records a terminal completion key while the worker advances the record", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const base = {
      importId,
      requestedBy: "usr_owner",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await f.useCases.complete({ ...base, idempotencyKey: "complete-first" });
    const recordReplay = f.repository.recordCompletionReplay.bind(f.repository);
    vi.spyOn(f.repository, "recordCompletionReplay").mockImplementationOnce(
      async (id, replay) => {
        await f.repository.transition({
          importId,
          expectedState: "UPLOADED",
          expectedVersion: f.current()!.version,
          nextState: "VALIDATING",
          patch: {},
        });
        return recordReplay(id, replay);
      },
    );

    await expect(
      f.useCases.complete({ ...base, idempotencyKey: "complete-later" }),
    ).resolves.toMatchObject({ data: { state: "VALIDATING" } });
    expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it("returns a terminal replay when another completion wins before claim recovery", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    vi.spyOn(f.repository, "beginCompletion").mockResolvedValueOnce({
      ...f.current()!,
      state: "UPLOADED",
      version: 4,
      physicalVersion: "version-winner",
      progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
    });

    await expect(
      f.useCases.complete({
        importId,
        requestedBy: "usr_owner",
        idempotencyKey: "complete-losing-claim",
        parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
      }),
    ).resolves.toMatchObject({ data: { state: "UPLOADED" } });
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("converges concurrent completion calls with the same key and manifest", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-concurrent",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };

    const results = await Promise.all([
      f.useCases.complete(input),
      f.useCases.complete(input),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ state: "UPLOADED" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ state: "UPLOADED" }),
      }),
    ]);
    expect(f.current()?.state).toBe("UPLOADED");
  });
  it("retains the completion fingerprint when the intent acknowledgement is lost", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const begin = f.repository.beginCompletion.bind(f.repository);
    vi.spyOn(f.repository, "beginCompletion").mockImplementationOnce(
      async (...args) => {
        await begin(...args);
        throw new Error("completion transaction acknowledgement lost");
      },
    );
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-lost-ack",
      parts: [{ partNumber: 1, etag: "etag", checksumSha256: checksum }],
    };
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      status: 503,
    });

    await expect(
      f.useCases.complete({
        ...input,
        parts: [{ ...input.parts[0], etag: "different" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("cleans up the losing concurrent restart and preserves one committed generation", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "concurrent-restart",
    };
    const results = await Promise.all([
      f.useCases.restart(input),
      f.useCases.restart(input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.current()).toMatchObject({
      uploadGeneration: 2,
      uploadId: "upload-2",
    });
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-1");
    expect(f.store.abort).toHaveBeenCalledWith(f.current()?.key, "upload-3");
    await f.useCases.restart(input);
    expect(f.store.create).toHaveBeenCalledTimes(3);
  });
  it("rejects corrupt upload geometry instead of guessing defaults", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    await f.repository.patch({
      importId,
      expectedState: "UPLOADING",
      expectedVersion: 2,
      patch: { expectedPartCount: 10 },
    });
    await expect(
      f.useCases.signParts({
        importId,
        requestedBy: "usr_owner",
        parts: [{ partNumber: 1, checksumSha256: checksum }],
      }),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(f.store.signParts).not.toHaveBeenCalled();
  });
  it("rejects noncanonical checksums before signing", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    await expect(
      f.useCases.signParts({
        importId,
        requestedBy: "usr_owner",
        parts: [{ partNumber: 1, checksumSha256: "A".repeat(42) + "B=" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.store.signParts).not.toHaveBeenCalled();
  });
  it("does not advance after invalid manifest or failed HEAD", async () => {
    const f = importFixture();
    const {
      data: { importId },
    } = await f.useCases.start(startInput);
    const part = { partNumber: 1, etag: "etag", checksumSha256: checksum };
    const input = {
      importId,
      requestedBy: "usr_owner",
      idempotencyKey: "complete-key",
      parts: [part, part],
    };
    await expect(f.useCases.complete(input)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(f.store.complete).not.toHaveBeenCalled();
    f.store.head.mockRejectedValueOnce(new Error("size mismatch"));
    await expect(
      f.useCases.complete({ ...input, parts: [part] }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.current()?.state).toBe("UPLOADING");
  });
});

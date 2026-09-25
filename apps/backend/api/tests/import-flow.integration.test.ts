import { describe, expect, it, vi } from "vitest";
import { ImportUseCases } from "../src/modules/imports/application/import-use-cases.ts";
import { DatasetActivationConflictError } from "../src/modules/imports/ports/dataset-activation.ts";
import type { ImportRecord } from "../src/modules/imports/domain/import.ts";
import type { ImportRepository } from "../src/modules/imports/ports/import-repository.ts";
import type { ImportUploadStore } from "../src/modules/imports/ports/import-upload-store.ts";
import {
  checksum,
  importFixture,
  startInput,
} from "./support/import-fixture.ts";

const OWNER = "usr_owner";
const READER = "usr_reader";
const PART_SIZE_BYTES = 16 * 1024 * 1024;
const CANDIDATE_VERSION = `dsv_${"a".repeat(64)}`;
const FORBIDDEN_PUBLIC_PROPERTIES = [
  "bucket",
  "key",
  "uploadId",
  "taskArn",
  "physicalVersion",
  "partSizeBytes",
  "expectedPartCount",
  "uploadGeneration",
  "uploadExpiresAt",
  "completionRequestedAt",
  "completionUploadGeneration",
] as const;

function fakeBrowserUpload(store: ImportUploadStore) {
  let uploaded = false;
  const part = {
    partNumber: 1,
    etag: "etag-1",
    checksumSha256: checksum,
    sizeBytes: startInput.sizeBytes,
  };

  vi.mocked(store.listParts).mockImplementation(async () =>
    uploaded ? [part] : [],
  );
  vi.mocked(store.getUploadedProgress).mockImplementation(async () => ({
    completedBytes: uploaded ? startInput.sizeBytes : 0,
  }));
  vi.mocked(store.complete).mockImplementation(async (input) => {
    expect(uploaded).toBe(true);
    expect(input).toMatchObject({
      uploadId: "upload-1",
      parts: [
        {
          partNumber: part.partNumber,
          etag: part.etag,
          checksumSha256: part.checksumSha256,
        },
      ],
      expectedSizeBytes: startInput.sizeBytes,
      expectedPartCount: 1,
    });
    return { versionId: "version-1" };
  });
  vi.mocked(store.head).mockImplementation(
    async (key, versionId, expectedSizeBytes) => {
      expect(key).toMatch(/^staging\/imports\/imp_[0-9A-Z]{26}\/source$/);
      expect(versionId).toBe("version-1");
      expect(expectedSizeBytes).toBe(startInput.sizeBytes);
      return { sizeBytes: expectedSizeBytes };
    },
  );

  return {
    async upload() {
      uploaded = true;
    },
    completedPart: {
      partNumber: part.partNumber,
      etag: part.etag,
      checksumSha256: part.checksumSha256,
    },
  };
}

async function fakeWorker(
  repository: ImportRepository,
  importId: string,
  activation: { activate: ReturnType<typeof vi.fn> },
): Promise<ImportRecord> {
  const uploaded = await repository.get(importId);
  expect(uploaded).toMatchObject({ state: "UPLOADED" });
  const validating = await repository.transition({
    importId,
    expectedState: "UPLOADED",
    expectedVersion: uploaded!.version,
    nextState: "VALIDATING",
    patch: {
      updatedAt: "2026-09-17T10:01:00.000Z",
      progress: {
        kind: "stage",
        stage: "validating",
        recordsRead: 0,
        recordsWritten: 0,
        recordsRejected: 0,
      },
    },
  });
  const processing = await repository.transition({
    importId,
    expectedState: "VALIDATING",
    expectedVersion: validating.version,
    nextState: "PROCESSING",
    patch: {
      updatedAt: "2026-09-17T10:02:00.000Z",
      progress: {
        kind: "stage",
        stage: "processing",
        recordsRead: 1,
        recordsWritten: 1,
        recordsRejected: 0,
      },
    },
  });

  // Publication only records a candidate. Activation is a separate operation.
  expect(activation.activate).not.toHaveBeenCalled();
  return repository.releaseTerminal(importId, processing.version, "READY", {
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/import-test",
    candidateVersion: CANDIDATE_VERSION,
    updatedAt: "2026-09-17T10:03:00.000Z",
    error: null,
    progress: {
      kind: "stage",
      stage: "published",
      recordsRead: 1,
      recordsWritten: 1,
      recordsRejected: 0,
    },
  });
}

function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...propertyNames(nested),
  ]);
}

describe("Argus import flow", () => {
  it("lets any authenticated reader activate a READY candidate and exposes the active version", async () => {
    const f = importFixture();
    const activation = {
      getActiveVersion: vi.fn(async () => null as string | null),
      activate: vi.fn(async (input: Record<string, string>) => ({
        importId: input.importId,
        datasetVersion: input.candidateVersion,
        activatedAt: "2026-09-17T10:04:00.000Z",
        activatedBy: input.requestedBy,
        changed: true,
      })),
    };
    const useCases = new ImportUseCases(f.repository, f.store, {
      bucket: "imports-test",
      now: () => new Date("2026-09-17T10:04:00.000Z"),
      activation,
    } as never);
    const started = await f.useCases.start(startInput);
    await f.repository.releaseTerminal(
      started.data.importId,
      f.current()!.version,
      "READY",
      {
        candidateVersion: CANDIDATE_VERSION,
        updatedAt: "2026-09-17T10:03:00.000Z",
        error: null,
        progress: { kind: "none" },
      },
    );

    const activated = await (
      useCases as unknown as {
        activate(input: {
          importId: string;
          requestedBy: string;
          idempotencyKey: string;
        }): Promise<{ data: Record<string, unknown> }>;
      }
    ).activate({
      importId: started.data.importId,
      requestedBy: READER,
      idempotencyKey: "activate-ready-candidate",
    });

    expect(activated.data).toEqual({
      importId: started.data.importId,
      datasetVersion: CANDIDATE_VERSION,
      activatedAt: "2026-09-17T10:04:00.000Z",
      activatedBy: READER,
      changed: true,
    });
    expect(activation.activate).toHaveBeenCalledWith({
      importId: started.data.importId,
      candidateVersion: CANDIDATE_VERSION,
      requestedBy: READER,
      idempotencyKey: "activate-ready-candidate",
      activatedAt: "2026-09-17T10:04:00.000Z",
    });

    activation.getActiveVersion.mockResolvedValueOnce(CANDIDATE_VERSION);
    const history = await useCases.list({ requestedBy: READER, limit: 20 });
    expect(history.data).toMatchObject({
      activeDatasetVersion: CANDIDATE_VERSION,
    });
  });

  it("refuses activation until the import has a READY candidate", async () => {
    const f = importFixture();
    const activation = {
      getActiveVersion: vi.fn(async () => null),
      activate: vi.fn(),
    };
    const useCases = new ImportUseCases(f.repository, f.store, {
      bucket: "imports-test",
      activation,
    } as never);
    const started = await f.useCases.start(startInput);

    await expect(
      (
        useCases as unknown as {
          activate(input: {
            importId: string;
            requestedBy: string;
            idempotencyKey: string;
          }): Promise<unknown>;
        }
      ).activate({
        importId: started.data.importId,
        requestedBy: READER,
        idempotencyKey: "activate-too-early",
      }),
    ).rejects.toMatchObject({ status: 409, code: "IMPORT_STATE_CONFLICT" });
    expect(activation.activate).not.toHaveBeenCalled();
  });

  it("returns a safe conflict when another candidate wins the activation race", async () => {
    const f = importFixture();
    const activation = {
      getActiveVersion: vi.fn(async () => null),
      activate: vi.fn(async () => {
        throw new DatasetActivationConflictError();
      }),
    };
    const useCases = new ImportUseCases(f.repository, f.store, {
      bucket: "imports-test",
      activation,
    } as never);
    const started = await f.useCases.start(startInput);
    await f.repository.releaseTerminal(
      started.data.importId,
      f.current()!.version,
      "READY",
      {
        candidateVersion: CANDIDATE_VERSION,
        updatedAt: "2026-09-17T10:03:00.000Z",
        error: null,
        progress: { kind: "none" },
      },
    );

    await expect(
      useCases.activate({
        importId: started.data.importId,
        requestedBy: READER,
        idempotencyKey: "activation-race",
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("keeps the upload owner-managed, processing shared, durable and non-activating", async () => {
    const f = importFixture();
    const browser = fakeBrowserUpload(f.store);
    const activation = { activate: vi.fn(async () => undefined) };

    const started = await f.useCases.start(startInput);
    const { importId } = started.data;
    expect(started.data).toMatchObject({
      requestedBy: OWNER,
      canManageUpload: true,
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
      state: "UPLOADING",
      progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
    });
    expect(f.current()).toMatchObject({
      partSizeBytes: PART_SIZE_BYTES,
      expectedPartCount: 1,
      uploadExpiresAt: "2026-09-18T10:00:00.000Z",
    });

    const signed = await f.useCases.signParts({
      importId,
      requestedBy: OWNER,
      parts: [{ partNumber: 1, checksumSha256: checksum }],
    });
    expect(signed.data.parts).toEqual([
      {
        partNumber: 1,
        url: "https://upload.test/part",
        headers: { "x-amz-checksum-sha256": checksum },
        expiresAt: "2026-09-17T10:15:00.000Z",
      },
    ]);

    await browser.upload();
    const ownerEvidence = await f.useCases.listParts(importId, OWNER);
    expect(ownerEvidence.data.parts).toEqual([
      {
        partNumber: 1,
        etag: "etag-1",
        checksumSha256: checksum,
        sizeBytes: 1024,
      },
    ]);
    const sharedUploading = await f.useCases.get(importId, READER);
    expect(sharedUploading.data).toMatchObject({
      state: "UPLOADING",
      canManageUpload: false,
      progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
    });

    const forbiddenMutations = [
      f.useCases.signParts({
        importId,
        requestedBy: READER,
        parts: [{ partNumber: 1, checksumSha256: checksum }],
      }),
      f.useCases.listParts(importId, READER),
      f.useCases.restart({
        importId,
        requestedBy: READER,
        idempotencyKey: "reader-restart",
      }),
      f.useCases.complete({
        importId,
        requestedBy: READER,
        idempotencyKey: "reader-complete",
        parts: [browser.completedPart],
      }),
    ];
    for (const mutation of forbiddenMutations) {
      await expect(mutation).rejects.toMatchObject({
        status: 403,
        code: "IMPORT_NOT_OWNED",
      });
    }

    const uploaded = await f.useCases.complete({
      importId,
      requestedBy: OWNER,
      idempotencyKey: "complete-1",
      parts: [browser.completedPart],
    });
    expect(uploaded.data).toMatchObject({
      state: "UPLOADED",
      progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
    });

    await fakeWorker(f.repository, importId, activation);
    const sharedReady = await f.useCases.get(importId, READER);
    const history = await f.useCases.list({
      requestedBy: READER,
      limit: 20,
    });
    expect(sharedReady.data).toMatchObject({
      state: "READY",
      candidateVersion: CANDIDATE_VERSION,
      canManageUpload: false,
    });
    expect(history.data).toEqual({ items: [sharedReady.data], cursor: null });
    expect(await f.repository.getActive()).toBeNull();
    expect(activation.activate).not.toHaveBeenCalled();

    const publicPayloads = [
      started.data,
      sharedUploading.data,
      uploaded.data,
      sharedReady.data,
      history.data,
    ];
    const publicProperties = propertyNames(publicPayloads);
    for (const forbidden of FORBIDDEN_PUBLIC_PROPERTIES) {
      expect(
        publicProperties,
        `public payload leaked the physical property ${forbidden}`,
      ).not.toContain(forbidden);
    }

    const physical = f.current();
    expect(physical).toMatchObject({
      bucket: "imports-test",
      key: `staging/imports/${importId}/source`,
      uploadId: "upload-1",
      taskArn: "arn:aws:ecs:us-east-1:123456789012:task/import-test",
      physicalVersion: "version-1",
    });
    const publicJson = JSON.stringify(publicPayloads);
    const forbiddenPhysicalValues = [
      physical!.bucket,
      physical!.key,
      physical!.uploadId!,
      physical!.taskArn!,
      physical!.physicalVersion!,
      "https://upload.test/part",
      "etag-1",
      checksum,
    ];
    for (const forbidden of forbiddenPhysicalValues) {
      expect(
        publicJson,
        `public payload leaked the physical value ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });
});

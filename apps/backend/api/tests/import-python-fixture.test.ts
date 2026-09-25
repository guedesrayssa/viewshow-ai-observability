import { readFileSync } from "node:fs";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { importSnapshotSchema } from "@view-show/contracts";
import { expect, it, vi } from "vitest";
import { DynamoImportRepository } from "../src/modules/imports/adapters/dynamodb-import-repository.js";
import {
  toPublicImport,
  type ImportRecord,
} from "../src/modules/imports/domain/import.js";

// Independent typed writer input; the expected document lives in the shared JSON fixture.
const uploaded: ImportRecord = {
  importId: "imp_01K59Z5XE00000000000000000",
  requestedBy: "usr_owner",
  author: {
    id: "usr_owner",
    name: "Import Owner",
    email: "owner@example.test",
  },
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:01:00.000Z",
  state: "UPLOADED",
  version: 4,
  progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
  candidateVersion: null,
  error: {
    code: "ARCHIVE_PUBLICATION_FAILED",
    message: "Não foi possível publicar o arquivo canônico. Tente novamente.",
    requestId: "req_import_01K59Z5XE00000000000000000",
    stage: "ARCHIVING",
    retryable: true,
    attempt: 1,
    maxAttempts: null,
  },
  bucket: "imports-test",
  key: "staging/imports/imp_01K59Z5XE00000000000000000/source",
  uploadId: "upload-1",
  taskArn: null,
  physicalVersion: "s3-version-1",
  partSizeBytes: 16777216,
  expectedPartCount: 1,
  uploadGeneration: 1,
  uploadExpiresAt: "2026-09-18T10:00:00.000Z",
  completionRequestedAt: "2026-09-17T10:00:59.000Z",
  completionUploadGeneration: 1,
  pipelineVersion: "canonical-v2",
};

function setup() {
  const send = vi.fn().mockResolvedValue({});
  const repository = new DynamoImportRepository(
    "us-east-1",
    "imports-table",
    "test-secret",
    {
      send,
    } as unknown as DynamoDBDocumentClient,
  );
  return { send, repository };
}

it("writes the frozen Python document from an independent typed ImportRecord", async () => {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../ingestion-data/tests/fixtures/import_job_typescript.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { send, repository } = setup();
  await repository.createAndLock(uploaded, "compatibility-fixture");
  expect(send.mock.calls[0]![0]).toBeInstanceOf(GetCommand);
  const transaction = send.mock.calls[1]![0];
  expect(transaction).toBeInstanceOf(TransactWriteCommand);
  expect(transaction.input.TransactItems[0].Put.Item).toEqual(fixture);
  expect(
    importSnapshotSchema.safeParse(toPublicImport(uploaded, "usr_owner"))
      .success,
  ).toBe(true);
});

it("preserves the same safe correlated error consumed by the Python worker", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../ingestion-data/tests/fixtures/import_job_typescript.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { error: unknown };
  const failure: ImportRecord = {
    ...uploaded,
    state: "FAILED",
    error: {
      code: "ARCHIVE_PUBLICATION_FAILED",
      message: "Não foi possível publicar o arquivo canônico. Tente novamente.",
      requestId: "req_import_01K59Z5XE00000000000000000",
      stage: "ARCHIVING",
      retryable: true,
      attempt: 1,
      maxAttempts: null,
    },
  };
  expect(
    importSnapshotSchema.parse(toPublicImport(failure, "usr_owner")).error,
  ).toEqual(fixture.error);
});

// Read actual SET assignments; canned Attributes responses cannot hide dropped fields.
function assignments(command: {
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}): Record<string, unknown> {
  expect(command.UpdateExpression).toMatch(/^SET /);
  return Object.fromEntries(
    command
      .UpdateExpression!.slice(4)
      .split(", ")
      .map((assignment) => {
        const [name, value] = assignment.split(" = ");
        return [
          command.ExpressionAttributeNames![name!],
          command.ExpressionAttributeValues![value!],
        ];
      }),
  );
}

it("persists preparation, completion intent, physical version and terminal fields", async () => {
  const { send, repository } = setup();
  send.mockResolvedValue({ Attributes: uploaded });
  await repository.transition({
    importId: uploaded.importId,
    expectedState: "PREPARING",
    expectedVersion: 1,
    nextState: "UPLOADING",
    patch: {
      key: "staging/imports/imp_01K59Z5XE00000000000000000/source",
      uploadId: "upload-1",
      partSizeBytes: 16777216,
      expectedPartCount: 1,
      uploadGeneration: 1,
      uploadExpiresAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
      progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
    },
  });
  const preparation = send.mock.calls.at(-1)![0];
  expect(preparation).toBeInstanceOf(UpdateCommand);
  expect(assignments(preparation.input)).toEqual({
    version: 2,
    state: "UPLOADING",
    key: "staging/imports/imp_01K59Z5XE00000000000000000/source",
    uploadId: "upload-1",
    partSizeBytes: 16777216,
    expectedPartCount: 1,
    uploadGeneration: 1,
    uploadExpiresAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
  });
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({
    Item: { ...uploaded, state: "UPLOADING", version: 3 },
  });
  await repository.beginCompletion(
    {
      importId: uploaded.importId,
      expectedState: "UPLOADING",
      expectedVersion: 2,
      patch: {
        completionRequestedAt: "2026-09-17T10:00:59.000Z",
        completionUploadGeneration: 1,
      },
    },
    {
      idempotencyKey: "completion-compatibility-fixture",
      uploadGeneration: 1,
      requestedBy: "usr_owner",
      parts: [
        {
          partNumber: 1,
          etag: '"etag"',
          checksumSha256: "A".repeat(43) + "=",
        },
      ],
    },
  );
  const completion = send.mock.calls.at(-2)![0];
  expect(completion).toBeInstanceOf(TransactWriteCommand);
  expect(assignments(completion.input.TransactItems[0].Update)).toEqual({
    version: 3,
    completionRequestedAt: "2026-09-17T10:00:59.000Z",
    completionUploadGeneration: 1,
  });
  await repository.transition({
    importId: uploaded.importId,
    expectedState: "UPLOADING",
    expectedVersion: 3,
    nextState: "UPLOADED",
    patch: {
      physicalVersion: "s3-version-1",
      updatedAt: "2026-09-17T10:01:00.000Z",
      progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
    },
  });
  expect(assignments(send.mock.calls.at(-1)![0].input)).toEqual({
    version: 4,
    state: "UPLOADED",
    physicalVersion: "s3-version-1",
    updatedAt: "2026-09-17T10:01:00.000Z",
    progress: { kind: "bytes", completedBytes: 1024, totalBytes: 1024 },
  });
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({
    Item: {
      ...uploaded,
      pk: "IMPORTS",
      sk: `IMPORT#${uploaded.importId}`,
      state: "READY",
      version: 7,
    },
  });
  await repository.releaseTerminal(uploaded.importId, 6, "READY", {
    physicalVersion: "s3-version-1",
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/worker/123",
    candidateVersion: `dsv_${"a".repeat(64)}`,
    updatedAt: "2026-09-17T10:05:00.000Z",
    error: null,
    progress: {
      kind: "stage",
      stage: "published",
      recordsRead: 1,
      recordsWritten: 1,
      recordsRejected: 0,
    },
  });
  const terminal = send.mock.calls.at(-2)![0];
  expect(terminal).toBeInstanceOf(TransactWriteCommand);
  expect(assignments(terminal.input.TransactItems[0].Update)).toEqual({
    state: "READY",
    version: 7,
    physicalVersion: "s3-version-1",
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/worker/123",
    candidateVersion: `dsv_${"a".repeat(64)}`,
    updatedAt: "2026-09-17T10:05:00.000Z",
    error: null,
    progress: {
      kind: "stage",
      stage: "published",
      recordsRead: 1,
      recordsWritten: 1,
      recordsRejected: 0,
    },
  });
  expect(terminal.input.TransactItems[1].Delete.Key).toEqual({
    pk: "CONTROL#IMPORT",
    sk: "ACTIVE",
  });
});

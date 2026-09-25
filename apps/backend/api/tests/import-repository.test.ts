import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { DynamoImportRepository } from "../src/modules/imports/adapters/dynamodb-import-repository.js";
import type { ImportRecord } from "../src/modules/imports/domain/import.js";

const secret = "cursor-secret-for-import-repository";
const record: ImportRecord = {
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Ana", email: "ana@example.test" },
  fileName: "dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:00.000Z",
  state: "PREPARING",
  version: 1,
  progress: { kind: "none" },
  candidateVersion: null,
  error: null,
  bucket: "imports",
  key: "private/object",
  uploadId: null,
  taskArn: null,
  physicalVersion: null,
};
const key = { pk: "IMPORTS", sk: `IMPORT#${record.importId}` };
const lock = { pk: "CONTROL#IMPORT", sk: "ACTIVE" };
const physical = (value = record) => ({ ...value, ...key });
const completionReplay = {
  idempotencyKey: "completion-key",
  uploadGeneration: 1,
  requestedBy: "usr_owner",
  parts: [
    {
      partNumber: 1,
      etag: '"etag"',
      checksumSha256: "A".repeat(43) + "=",
    },
  ],
};
const completionMapping = () => ({
  pk: `IMPORT_COMPLETION#${createHmac("sha256", secret)
    .update(JSON.stringify([record.importId, completionReplay.idempotencyKey]))
    .digest("base64url")}`,
  sk: "COMPLETE",
  importId: record.importId,
  fingerprint: createHmac("sha256", secret)
    .update(
      `imports:complete:${JSON.stringify([
        record.importId,
        completionReplay.uploadGeneration,
        completionReplay.requestedBy,
        completionReplay.parts.map((part) => [
          part.partNumber,
          part.etag,
          part.checksumSha256,
        ]),
      ])}`,
    )
    .digest("base64url"),
});
function setup() {
  const send = vi.fn().mockResolvedValue({});
  return {
    send,
    repository: new DynamoImportRepository("us-east-1", "table", secret, {
      send,
    } as unknown as DynamoDBDocumentClient),
  };
}
function cancelled(codes: string[]) {
  return Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe("import repository", () => {
  it("allows only one concurrent pipeline reservation", async () => {
    const { repository, send } = setup();
    const reservePipeline = (
      repository as unknown as {
        reservePipeline(input: {
          importId: string;
          expectedVersion: number;
          pipelineVersion: "legacy-v1" | "canonical-v2";
          updatedAt: string;
        }): Promise<ImportRecord>;
      }
    ).reservePipeline;
    send
      .mockResolvedValueOnce({
        Attributes: physical({
          ...record,
          version: 2,
          pipelineVersion: "canonical-v2",
          updatedAt: "2026-09-17T10:01:00.000Z",
        }),
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("already reserved"), {
          name: "ConditionalCheckFailedException",
        }),
      );
    const input = {
      importId: record.importId,
      expectedVersion: 1,
      updatedAt: "2026-09-17T10:01:00.000Z",
    };

    await expect(
      reservePipeline.call(repository, {
        ...input,
        pipelineVersion: "canonical-v2",
      }),
    ).resolves.toMatchObject({ pipelineVersion: "canonical-v2", version: 2 });
    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toMatchObject({
      TableName: "table",
      Key: key,
      ConditionExpression:
        "attribute_exists(pk) AND attribute_not_exists(#pipelineVersion) AND #version = :expectedVersion",
      ExpressionAttributeNames: {
        "#pipelineVersion": "pipelineVersion",
        "#updatedAt": "updatedAt",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":pipelineVersion": "canonical-v2",
        ":updatedAt": "2026-09-17T10:01:00.000Z",
        ":expectedVersion": 1,
        ":nextVersion": 2,
      },
    });
    await expect(
      reservePipeline.call(repository, {
        ...input,
        pipelineVersion: "legacy-v1",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
  });

  it("acquires and renews a 45-second reconciliation lease using explicit expiry", async () => {
    const { repository, send } = setup();
    send.mockResolvedValue({});

    await expect(
      repository.tryAcquireReconcileLease({
        owner: "process-a",
        nowEpochSeconds: 1_800_000_000,
        expiresAtEpochSeconds: 1_800_000_045,
      }),
    ).resolves.toBe(true);

    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toEqual({
      TableName: "table",
      Key: { pk: "CONTROL#IMPORT", sk: "RECONCILER" },
      UpdateExpression:
        "SET #owner = :owner, #expiresAt = :expiresAt, #ttl = :ttl",
      ConditionExpression:
        "attribute_not_exists(pk) OR #expiresAt <= :now OR #owner = :owner",
      ExpressionAttributeNames: {
        "#owner": "owner",
        "#expiresAt": "expiresAt",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":owner": "process-a",
        ":now": 1_800_000_000,
        ":expiresAt": 1_800_000_045,
        ":ttl": 1_800_000_345,
      },
    });
  });

  it("treats only a contested reconciliation lease as unavailable", async () => {
    const conditional = Object.assign(new Error("owned"), {
      name: "ConditionalCheckFailedException",
    });
    const { repository, send } = setup();
    send.mockRejectedValueOnce(conditional);
    await expect(
      repository.tryAcquireReconcileLease({
        owner: "process-b",
        nowEpochSeconds: 1,
        expiresAtEpochSeconds: 46,
      }),
    ).resolves.toBe(false);

    const infrastructure = new Error("dynamo unavailable");
    send.mockRejectedValueOnce(infrastructure);
    await expect(
      repository.tryAcquireReconcileLease({
        owner: "process-b",
        nowEpochSeconds: 1,
        expiresAtEpochSeconds: 46,
      }),
    ).rejects.toBe(infrastructure);
  });

  it("releases a reconciliation lease only for its current owner", async () => {
    const { repository, send } = setup();
    await expect(
      repository.releaseReconcileLease("process-a"),
    ).resolves.toBeUndefined();
    const command = send.mock.calls[0]![0] as DeleteCommand;
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command.input).toEqual({
      TableName: "table",
      Key: { pk: "CONTROL#IMPORT", sk: "RECONCILER" },
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" },
      ExpressionAttributeValues: { ":owner": "process-a" },
    });

    send.mockRejectedValueOnce(
      Object.assign(new Error("owner changed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    await expect(
      repository.releaseReconcileLease("process-a"),
    ).resolves.toBeUndefined();

    const infrastructure = new Error("network");
    send.mockRejectedValueOnce(infrastructure);
    await expect(repository.releaseReconcileLease("process-a")).rejects.toBe(
      infrastructure,
    );
  });
  it("records a losing restart replay without swapping or incrementing the record", async () => {
    const { repository, send } = setup();
    const current = {
      ...record,
      state: "UPLOADING" as const,
      version: 3,
      uploadGeneration: 2,
      uploadId: "winner",
    };
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: physical(current) });
    expect(
      await repository.recordRestartReplay(record.importId, 3, "loser"),
    ).toEqual(current);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toEqual([
      {
        ConditionCheck: {
          TableName: "table",
          Key: key,
          ConditionExpression:
            "attribute_exists(pk) AND #version = :expectedVersion",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":expectedVersion": 3 },
        },
      },
      {
        Put: {
          TableName: "table",
          Item: {
            pk: `IMPORT_RESTART#${createHmac("sha256", secret)
              .update(JSON.stringify([record.importId, "loser"]))
              .digest("base64url")}`,
            sk: "RESTART",
            importId: record.importId,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ]);
    const mapping = command.input.TransactItems[1].Put.Item;
    send
      .mockReset()
      .mockResolvedValueOnce({ Item: mapping })
      .mockResolvedValueOnce({
        Item: physical({ ...current, version: 9, uploadGeneration: 8 }),
      });
    expect(
      await repository.getRestartReplay(record.importId, "loser"),
    ).toMatchObject({ uploadGeneration: 8 });
  });
  it("accepts an already durable losing restart mapping after a conditional race", async () => {
    const { repository, send } = setup();
    send
      .mockRejectedValueOnce(cancelled(["None", "ConditionalCheckFailed"]))
      .mockResolvedValueOnce({ Item: { importId: record.importId } })
      .mockResolvedValueOnce({ Item: physical({ ...record, version: 4 }) });
    expect(
      await repository.recordRestartReplay(record.importId, 3, "same-key"),
    ).toMatchObject({ version: 4 });
    expect(
      send.mock.calls
        .slice(1)
        .every(
          ([command]) =>
            command instanceof GetCommand && command.input.ConsistentRead,
        ),
    ).toBe(true);
  });
  it("rejects stale losing-restart persistence when no replay was recorded", async () => {
    const { repository, send } = setup();
    send
      .mockRejectedValueOnce(cancelled(["ConditionalCheckFailed", "None"]))
      .mockResolvedValueOnce({});
    await expect(
      repository.recordRestartReplay(record.importId, 3, "loser"),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
  });
  it("preserves infrastructure failure when recording a losing restart", async () => {
    const { repository, send } = setup();
    const failure = new Error("database unavailable");
    send.mockRejectedValueOnce(failure);
    await expect(
      repository.recordRestartReplay(record.importId, 3, "loser"),
    ).rejects.toBe(failure);
  });
  it("conditionally reserves completion intent before an S3 effect", async () => {
    const { repository, send } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: physical({
        ...record,
        state: "UPLOADING",
        version: 3,
        completionRequestedAt: "now",
        completionUploadGeneration: 1,
      }),
    });
    await expect(
      repository.beginCompletion(
        {
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: 2,
          patch: {
            completionRequestedAt: "now",
            completionUploadGeneration: 1,
          },
        },
        completionReplay,
      ),
    ).resolves.toMatchObject({ completionUploadGeneration: 1 });
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems[0].Update.ConditionExpression).toContain(
      "attribute_not_exists(#completion)",
    );
    expect(
      command.input.TransactItems[0].Update.ExpressionAttributeNames[
        "#completion"
      ],
    ).toBe("completionRequestedAt");
    const mapping = command.input.TransactItems[1].Put.Item;
    expect(mapping).toMatchObject({
      pk: expect.stringMatching(/^IMPORT_COMPLETION#[A-Za-z0-9_-]+$/),
      sk: "COMPLETE",
      importId: record.importId,
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    expect(JSON.stringify(mapping)).not.toContain("completion-key");
    expect(JSON.stringify(mapping)).not.toContain('"etag"');
    expect(mapping).not.toHaveProperty("ttl");
  });
  it("recovers a matching completion ledger after a lost transaction acknowledgement", async () => {
    const { repository, send } = setup();
    const acknowledgementLost = new Error("transaction acknowledgement lost");
    const completing = {
      ...record,
      state: "UPLOADING" as const,
      version: 3,
      uploadGeneration: 1,
      completionRequestedAt: "now",
      completionUploadGeneration: 1,
    };
    send
      .mockRejectedValueOnce(acknowledgementLost)
      .mockResolvedValueOnce({ Item: completionMapping() })
      .mockResolvedValueOnce({ Item: physical(completing) });

    await expect(
      repository.beginCompletion(
        {
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: 2,
          patch: {
            completionRequestedAt: "now",
            completionUploadGeneration: 1,
          },
        },
        completionReplay,
      ),
    ).resolves.toEqual(completing);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1]![0].input).toMatchObject({
      Key: { pk: completionMapping().pk, sk: "COMPLETE" },
      ConsistentRead: true,
    });
  });
  it("maps completion transaction conditions but preserves infrastructure cancellation", async () => {
    const input = {
      importId: record.importId,
      expectedState: "UPLOADING" as const,
      expectedVersion: 2,
      patch: {
        completionRequestedAt: "now",
        completionUploadGeneration: 1,
      },
    };
    const contested = cancelled(["ConditionalCheckFailed", "None"]);
    const first = setup();
    first.send.mockRejectedValueOnce(contested).mockResolvedValueOnce({});
    await expect(
      first.repository.beginCompletion(input, completionReplay),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });

    const infrastructure = cancelled(["TransactionConflict", "None"]);
    const second = setup();
    second.send.mockRejectedValueOnce(infrastructure).mockResolvedValueOnce({});
    await expect(
      second.repository.beginCompletion(input, completionReplay),
    ).rejects.toBe(infrastructure);
  });
  it("rejects a completion replay when the same key has another fingerprint", async () => {
    const { repository, send } = setup();
    send.mockResolvedValueOnce({ Item: completionMapping() });

    await expect(
      repository.getCompletionReplay(record.importId, {
        ...completionReplay,
        parts: [{ ...completionReplay.parts[0], etag: '"different"' }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records a late completion key against stable owner and generation only", async () => {
    const { repository, send } = setup();
    const validating = {
      ...record,
      state: "VALIDATING" as const,
      version: 9,
      uploadGeneration: 1,
    };
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: physical(validating) });

    await expect(
      repository.recordCompletionReplay(record.importId, completionReplay),
    ).resolves.toEqual(validating);
    const command = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command.input.TransactItems[0].ConditionCheck).toEqual({
      TableName: "table",
      Key: key,
      ConditionExpression:
        "attribute_exists(pk) AND #owner = :owner AND #generation = :generation",
      ExpressionAttributeNames: {
        "#owner": "requestedBy",
        "#generation": "uploadGeneration",
      },
      ExpressionAttributeValues: {
        ":owner": "usr_owner",
        ":generation": 1,
      },
    });
    expect(command.input.TransactItems[1].Put.Item).toEqual(
      completionMapping(),
    );
  });
  it("persists multipart geometry through the allowlist", async () => {
    const { send, repository } = setup();
    const patch = {
      bucket: "imports",
      key: "staging/key",
      uploadId: "new-upload",
      uploadGeneration: 2,
      partSizeBytes: 16777216,
      expectedPartCount: 4,
      uploadExpiresAt: "2026-09-18T00:00:00Z",
      physicalVersion: "v1",
    };
    send.mockResolvedValue({
      Attributes: physical({ ...record, ...patch, version: 2 }),
    });
    await expect(
      repository.patch({
        importId: record.importId,
        expectedState: "UPLOADING",
        expectedVersion: 1,
        patch,
      }),
    ).resolves.toMatchObject(patch);
    expect(
      Object.values(send.mock.calls[0]![0].input.ExpressionAttributeNames),
    ).toEqual(expect.arrayContaining(Object.keys(patch)));
  });
  it("swaps uploads atomically with a separate durable restart mapping", async () => {
    const { send, repository } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: physical({
        ...record,
        state: "UPLOADING",
        version: 3,
        uploadId: "replacement",
      }),
    });
    expect(
      await repository.swapUploadForRestart(
        {
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: 2,
          patch: { uploadId: "replacement", uploadGeneration: 2 },
        },
        "restart-key",
      ),
    ).toMatchObject({ uploadId: "replacement", version: 3 });
    const transaction = send.mock.calls[0]![0].input.TransactItems;
    expect(transaction[0].Update).toMatchObject({
      Key: key,
      ConditionExpression:
        "attribute_exists(pk) AND #state = :expectedState AND #version = :expectedVersion AND attribute_not_exists(#completion)",
    });
    expect(transaction[1].Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(pk)",
      Item: { importId: record.importId, generation: 2 },
    });
    expect(JSON.stringify(transaction[1].Put.Item)).not.toContain(
      "restart-key",
    );
    expect(transaction[1].Put.Item).not.toHaveProperty("ttl");
    send
      .mockReset()
      .mockResolvedValueOnce({ Item: transaction[1].Put.Item })
      .mockResolvedValueOnce({
        Item: physical({
          ...record,
          state: "UPLOADING",
          version: 6,
          uploadId: "later-upload",
        }),
      });
    expect(
      await repository.getRestartReplay(record.importId, "restart-key"),
    ).toMatchObject({ uploadId: "later-upload" });
  });
  it("maps restart transaction races to a conflict", async () => {
    const { send, repository } = setup();
    send.mockRejectedValueOnce(cancelled(["ConditionalCheckFailed", "None"]));
    await expect(
      repository.swapUploadForRestart(
        {
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: 2,
          patch: { uploadId: "loser" },
        },
        "restart-key",
      ),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
  });
  it("creates record, exclusive global lock and durable idempotency mapping atomically", async () => {
    const { send, repository } = setup();
    expect(await repository.createAndLock(record, "idem-start-1")).toEqual(
      record,
    );
    const command = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )![0];
    expect(command.input.TransactItems).toEqual([
      {
        Put: {
          TableName: "table",
          Item: physical(),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: "table",
          Item: { ...lock, importId: record.importId },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: "table",
          Item: expect.objectContaining({
            importId: record.importId,
            fingerprint: expect.any(String),
          }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ]);
    const mapping = command.input.TransactItems[2].Put.Item;
    expect(mapping.pk).not.toBe("IMPORTS");
    expect(JSON.stringify(mapping)).not.toContain("idem-start-1");
    expect(mapping).not.toHaveProperty("ttl");
    expect(mapping).not.toHaveProperty("expiresAt");
  });

  it("replays the original terminal record across repository instances and generated IDs", async () => {
    const first = setup();
    await first.repository.createAndLock(record, "same-key");
    const mapping = first.send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )![0].input.TransactItems[2].Put.Item;
    const second = setup();
    second.send.mockResolvedValueOnce({ Item: mapping }).mockResolvedValueOnce({
      Item: physical({ ...record, state: "READY", version: 8 }),
    });
    expect(
      await second.repository.createAndLock(
        {
          ...record,
          importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
          createdAt: "later",
          key: "different-generated-key",
          author: { ...record.author, name: "Renamed" },
        },
        "same-key",
      ),
    ).toMatchObject({ importId: record.importId, state: "READY", version: 8 });
    expect(
      second.send.mock.calls.every(
        ([command]) =>
          command instanceof GetCommand && command.input.ConsistentRead,
      ),
    ).toBe(true);
  });

  it.each([
    { sizeBytes: 2048 },
    { fileName: "other.sql.gz" },
    { snapshotExtractedOn: "2026-09-18" },
    { requestedBy: "another" },
  ])("rejects reuse with a changed payload or actor: %j", async (changes) => {
    const { send, repository } = setup();
    await repository.createAndLock(record, "same-key");
    const mapping = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )![0].input.TransactItems[2].Put.Item;
    send.mockClear().mockResolvedValue({ Item: mapping });
    await expect(
      repository.createAndLock({ ...record, ...changes }, "same-key"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("resolves concurrent identical starts by rereading the durable mapping", async () => {
    const { send, repository } = setup();
    await repository.createAndLock(record, "race");
    const mapping = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )![0].input.TransactItems[2].Put.Item;
    send
      .mockReset()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        cancelled(["None", "ConditionalCheckFailed", "ConditionalCheckFailed"]),
      )
      .mockResolvedValueOnce({ Item: mapping })
      .mockResolvedValueOnce({ Item: physical() });
    expect(await repository.createAndLock(record, "race")).toEqual(record);
  });

  it("translates a contested lock to IMPORT_IN_PROGRESS", async () => {
    const { send, repository } = setup();
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        cancelled(["None", "ConditionalCheckFailed", "None"]),
      )
      .mockResolvedValue({});
    await expect(
      repository.createAndLock(record, "new-key"),
    ).rejects.toMatchObject({ code: "IMPORT_IN_PROGRESS", status: 409 });
  });

  it.each([
    new Error("network unavailable"),
    cancelled(["None", "ProvisionedThroughputExceeded", "None"]),
    Object.assign(new Error("unknown cancellation"), {
      name: "TransactionCanceledException",
    }),
  ])("preserves nonconditional failures: %s", async (error) => {
    const { send, repository } = setup();
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(error);
    await expect(repository.createAndLock(record, "new-key")).rejects.toBe(
      error,
    );
  });

  it("reads records and the active lock consistently without leaking physical keys", async () => {
    const { send, repository } = setup();
    send
      .mockResolvedValueOnce({ Item: physical() })
      .mockResolvedValueOnce({ Item: { ...lock, importId: record.importId } })
      .mockResolvedValueOnce({ Item: physical() });
    expect(await repository.get(record.importId)).toEqual(record);
    expect(await repository.getActive()).toEqual(record);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual(
      [key, lock, key].map((Key) => ({
        TableName: "table",
        Key,
        ConsistentRead: true,
      })),
    );
    expect(await repository.get("missing")).toBeNull();
    expect(await repository.getActive()).toBeNull();
  });

  it("queries newest first and resumes using a signed public ID cursor", async () => {
    const { send, repository } = setup();
    send
      .mockResolvedValueOnce({ Items: [physical()], LastEvaluatedKey: key })
      .mockResolvedValueOnce({ Items: [] });
    const page = await repository.list({ limit: 5 });
    expect(page.items).toEqual([record]);
    const command = send.mock.calls[0]![0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toMatchObject({
      TableName: "table",
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: 5,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": "IMPORTS", ":prefix": "IMPORT#" },
    });
    const payload = JSON.parse(
      Buffer.from(page.cursor!.split(".")[0]!, "base64url").toString(),
    );
    expect(payload).toEqual({
      version: 1,
      importId: record.importId,
      fingerprint: "imports:newest:5",
    });
    expect(JSON.stringify(payload)).not.toMatch(/pk|sk|IMPORT#/);
    expect(await repository.list({ limit: 5, cursor: page.cursor })).toEqual({
      items: [],
    });
    expect(send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual(key);
    await expect(
      repository.list({ limit: 6, cursor: page.cursor }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each(["garbage", "abc.def", "a.b.c", ".", "e30.invalid"])(
    "rejects malformed or tampered cursors before accessing DynamoDB: %s",
    async (cursor) => {
      const { send, repository } = setup();
      await expect(repository.list({ limit: 5, cursor })).rejects.toMatchObject(
        { code: "VALIDATION_ERROR" },
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rejects a correctly signed payload with an invalid public ID", async () => {
    const { repository } = setup();
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        importId: "../../physical",
        fingerprint: "imports:newest:5",
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(`imports:cursor:${payload}`)
      .digest("base64url");
    await expect(
      repository.list({ limit: 5, cursor: `${payload}.${signature}` }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("conditionally transitions state/version and aliases patch fields", async () => {
    const { send, repository } = setup();
    send.mockResolvedValue({
      Attributes: physical({
        ...record,
        state: "UPLOADING",
        version: 2,
        uploadId: "upload",
      }),
    });
    expect(
      await repository.transition({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: 1,
        nextState: "UPLOADING",
        patch: { uploadId: "upload" },
      }),
    ).toMatchObject({ state: "UPLOADING", version: 2, uploadId: "upload" });
    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toMatchObject({
      Key: key,
      ReturnValues: "ALL_NEW",
      ConditionExpression:
        "attribute_exists(pk) AND #state = :expectedState AND #version = :expectedVersion",
    });
    expect(command.input.ExpressionAttributeNames).toMatchObject({
      "#state": "state",
      "#version": "version",
      "#p0": "uploadId",
    });
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":expectedState": "PREPARING",
      ":expectedVersion": 1,
      ":nextState": "UPLOADING",
      ":nextVersion": 2,
      ":p0": "upload",
    });
  });

  it("patches active records with optimistic versioning without changing state", async () => {
    const { send, repository } = setup();
    send.mockResolvedValue({ Attributes: physical({ ...record, version: 2 }) });
    expect(
      await repository.patch({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: 1,
        patch: { updatedAt: "now" },
      }),
    ).toMatchObject({ version: 2 });
    expect(send.mock.calls[0]![0].input.UpdateExpression).not.toContain(
      "#state =",
    );
    expect(
      send.mock.calls[0]![0].input.ExpressionAttributeValues,
    ).toMatchObject({ ":expectedVersion": 1, ":nextVersion": 2 });
  });

  it.each([
    "pk",
    "sk",
    "state",
    "version",
    "importId",
    "requestedBy",
    "author",
    "progress.x = :hack",
  ])("rejects unsafe or immutable patch attribute %s", async (name) => {
    const { send, repository } = setup();
    await expect(
      repository.patch({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: 1,
        patch: { [name]: "bad" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects illegal transitions and requires terminal transitions to release the lock", async () => {
    const { send, repository } = setup();
    for (const nextState of ["PROCESSING", "FAILED"] as const) {
      await expect(
        repository.transition({
          importId: record.importId,
          expectedState: "PREPARING",
          expectedVersion: 1,
          nextState,
          patch: {},
        }),
      ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("maps conditional update rejection to a deterministic state conflict", async () => {
    const { send, repository } = setup();
    send.mockRejectedValue(
      Object.assign(new Error("race"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    await expect(
      repository.patch({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: 1,
        patch: {},
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
  });

  it.each([0, -1, 101, 1.5, NaN])(
    "rejects invalid list limits: %s",
    async (limit) => {
      const { send, repository } = setup();
      await expect(repository.list({ limit })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("does not mutate terminal records through patch", async () => {
    const { send, repository } = setup();
    await expect(
      repository.patch({
        importId: record.importId,
        expectedState: "READY",
        expectedVersion: 2,
        patch: {},
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves infrastructure failures on updates and terminal release", async () => {
    const { send, repository } = setup();
    const error = new Error("unavailable");
    send.mockRejectedValue(error);
    await expect(
      repository.patch({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: 1,
        patch: {},
      }),
    ).rejects.toBe(error);
    await expect(
      repository.releaseTerminal(record.importId, 1, "FAILED", {}),
    ).rejects.toBe(error);
  });

  it("does not hide a service failure behind another transaction condition failure", async () => {
    const { send, repository } = setup();
    const error = cancelled([
      "ProvisionedThroughputExceeded",
      "ConditionalCheckFailed",
      "None",
    ]);
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(error);
    await expect(
      repository.createAndLock(record, "mixed-failure"),
    ).rejects.toBe(error);
  });

  it("rejects invalid expected versions before any writes", async () => {
    const { send, repository } = setup();
    for (const expectedVersion of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(
        repository.patch({
          importId: record.importId,
          expectedState: "PREPARING",
          expectedVersion,
          patch: {},
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        repository.releaseTerminal(
          record.importId,
          expectedVersion,
          "FAILED",
          {},
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("atomically releases only the owned lock while conditionally entering a terminal state", async () => {
    const { send, repository } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: physical({
        ...record,
        state: "READY",
        version: 7,
        candidateVersion: "dataset-1",
      }),
    });
    expect(
      await repository.releaseTerminal(record.importId, 6, "READY", {
        candidateVersion: "dataset-1",
      }),
    ).toMatchObject({
      state: "READY",
      version: 7,
      candidateVersion: "dataset-1",
    });
    const command = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems![0]!.Update).toMatchObject({
      Key: key,
      ConditionExpression:
        "attribute_exists(pk) AND #state = :processing AND #version = :expectedVersion",
      ExpressionAttributeValues: {
        ":processing": "PROCESSING",
        ":expectedVersion": 6,
        ":nextState": "READY",
        ":nextVersion": 7,
      },
    });
    expect(command.input.TransactItems![0]!.Update!.UpdateExpression).toContain(
      "#version = :nextVersion",
    );
    expect(command.input.TransactItems![0]!.Update!.UpdateExpression).toContain(
      "#state = :nextState",
    );
    expect(command.input.TransactItems![1]!.Delete).toEqual({
      TableName: "table",
      Key: lock,
      ConditionExpression: "importId = :importId",
      ExpressionAttributeValues: { ":importId": record.importId },
    });
  });

  it("conditions failure on every permitted active state and returns a consistent terminal record", async () => {
    const { send, repository } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: physical({ ...record, state: "FAILED", version: 2 }),
    });
    expect(
      await repository.releaseTerminal(record.importId, 1, "FAILED", {}),
    ).toMatchObject({ state: "FAILED", version: 2 });
    const update = send.mock.calls[0]![0].input.TransactItems[0].Update;
    expect(update.ConditionExpression).toBe(
      "attribute_exists(pk) AND #state IN (:preparing, :uploading, :uploaded, :validating, :processing) AND #version = :expectedVersion",
    );
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":preparing": "PREPARING",
      ":uploading": "UPLOADING",
      ":uploaded": "UPLOADED",
      ":validating": "VALIDATING",
      ":processing": "PROCESSING",
      ":expectedVersion": 1,
      ":nextState": "FAILED",
      ":nextVersion": 2,
    });
    expect(update.UpdateExpression).toContain("#version = :nextVersion");
    expect(update.UpdateExpression).toContain("#state = :nextState");
    expect(send.mock.calls[1]![0].input).toMatchObject({
      Key: key,
      ConsistentRead: true,
    });
  });

  it("maps terminal transaction conflicts without deleting another import lock", async () => {
    const { send, repository } = setup();
    send.mockRejectedValueOnce(cancelled(["None", "ConditionalCheckFailed"]));
    await expect(
      repository.releaseTerminal(record.importId, 1, "FAILED", {}),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_CONFLICT" });
  });

  it("clears stale active locks only when they still point to the expected import", async () => {
    const { send, repository } = setup();
    expect(await repository.clearActiveLock(record.importId)).toBe(true);
    const command = send.mock.calls[0]![0] as DeleteCommand;
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command.input).toEqual({
      TableName: "table",
      Key: lock,
      ConditionExpression: "importId = :importId",
      ExpressionAttributeValues: { ":importId": record.importId },
    });
    send.mockRejectedValueOnce(
      Object.assign(new Error("changed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    expect(await repository.clearActiveLock(record.importId)).toBe(false);
    const error = new Error("network");
    send.mockRejectedValueOnce(error);
    await expect(repository.clearActiveLock(record.importId)).rejects.toBe(
      error,
    );
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ServiceError, type ImportState } from "@view-show/contracts";
import {
  assertImportTransition,
  isActiveImportState,
  type ImportPipelineVersion,
  type ImportRecord,
} from "../domain/import.js";
import type {
  CompletionReplayInput,
  ImportPatch,
  ImportRepository,
} from "../ports/import-repository.js";

const ACTIVE_KEY = { pk: "CONTROL#IMPORT", sk: "ACTIVE" };
const RECONCILER_KEY = { pk: "CONTROL#IMPORT", sk: "RECONCILER" };
const PATCH_FIELDS = new Set([
  "updatedAt",
  "progress",
  "candidateVersion",
  "error",
  "uploadId",
  "taskArn",
  "physicalVersion",
  "bucket",
  "key",
  "partSizeBytes",
  "expectedPartCount",
  "uploadGeneration",
  "uploadExpiresAt",
  "completionRequestedAt",
  "completionUploadGeneration",
]);
const recordKey = (importId: string) => ({
  pk: "IMPORTS",
  sk: `IMPORT#${importId}`,
});
const conflict = () =>
  new ServiceError(
    409,
    "IMPORT_STATE_CONFLICT",
    "O estado da importação foi alterado.",
  );
const idempotencyConflict = () =>
  new ServiceError(
    409,
    "CONFLICT",
    "A chave de idempotência já foi usada para outra solicitação.",
  );
const invalid = () =>
  new ServiceError(
    400,
    "VALIDATION_ERROR",
    "Parâmetros de importação inválidos.",
  );
function namedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
function conditionalReasons(
  error: unknown,
): readonly { Code?: string }[] | null {
  if (!namedError(error, "TransactionCanceledException")) return null;
  const reasons = (
    error as Error & { CancellationReasons?: { Code?: string }[] }
  ).CancellationReasons;
  // Throttling, validation and infrastructure cancellations must retain their cause.
  return reasons?.some((reason) => reason.Code === "ConditionalCheckFailed") &&
    reasons.every(
      (reason) =>
        reason.Code === "None" || reason.Code === "ConditionalCheckFailed",
    )
    ? reasons
    : null;
}
function fromItem(item: Record<string, unknown>): ImportRecord {
  const { pk: _pk, sk: _sk, ...record } = item;
  return record as ImportRecord;
}

export class DynamoImportRepository implements ImportRepository {
  private readonly client: DynamoDBDocumentClient;
  constructor(
    region: string,
    private readonly tableName: string,
    private readonly cursorSecret: string,
    client?: DynamoDBDocumentClient,
    endpoint?: string,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  private sign(value: string): string {
    return createHmac("sha256", this.cursorSecret)
      .update(value)
      .digest("base64url");
  }

  private async replay(
    key: Record<string, string>,
    fingerprint: string,
  ): Promise<ImportRecord | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return null;
    if (response.Item.fingerprint !== fingerprint) throw idempotencyConflict();
    const record = await this.get(response.Item.importId as string);
    if (!record)
      throw new Error(
        "Import idempotency mapping references a missing record.",
      );
    return record;
  }

  async createAndLock(
    record: ImportRecord,
    idempotencyKey: string,
  ): Promise<ImportRecord> {
    const token = this.sign(`imports:idempotency:${idempotencyKey}`);
    const key = { pk: `IMPORT_IDEMPOTENCY#${token}`, sk: "START" };
    const fingerprint = this.sign(
      `imports:start:${JSON.stringify([record.requestedBy, record.fileName, record.sizeBytes, record.snapshotExtractedOn])}`,
    );
    const existing = await this.replay(key, fingerprint);
    if (existing) return existing;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...record, ...recordKey(record.importId) },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...ACTIVE_KEY, importId: record.importId },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            // No TTL: start replay must remain valid after the import completes.
            {
              Put: {
                TableName: this.tableName,
                Item: { ...key, importId: record.importId, fingerprint },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return record;
    } catch (error) {
      const reasons = conditionalReasons(error);
      if (!reasons) throw error;
      const replay = await this.replay(key, fingerprint);
      if (replay) return replay;
      if (reasons[1]?.Code === "ConditionalCheckFailed")
        throw new ServiceError(
          409,
          "IMPORT_IN_PROGRESS",
          "Já existe uma importação em andamento.",
        );
      throw conflict();
    }
  }

  async get(importId: string): Promise<ImportRecord | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: recordKey(importId),
        ConsistentRead: true,
      }),
    );
    return response.Item ? fromItem(response.Item) : null;
  }

  async getActive(): Promise<ImportRecord | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: ACTIVE_KEY,
        ConsistentRead: true,
      }),
    );
    return response.Item ? this.get(response.Item.importId as string) : null;
  }

  private decodeCursor(cursor: string, fingerprint: string): string {
    try {
      if (
        cursor.length > 2048 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
      )
        throw invalid();
      const [payload, signature] = cursor.split(".") as [string, string];
      const expected = Buffer.from(this.sign(`imports:cursor:${payload}`));
      const supplied = Buffer.from(signature);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw invalid();
      const raw = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        !raw ||
        raw.version !== 1 ||
        raw.fingerprint !== fingerprint ||
        typeof raw.importId !== "string" ||
        !/^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(raw.importId)
      )
        throw invalid();
      return raw.importId;
    } catch {
      throw invalid();
    }
  }

  async list(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: readonly ImportRecord[]; cursor?: string }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw invalid();
    const fingerprint = `imports:newest:${input.limit}`;
    const start =
      input.cursor === undefined
        ? undefined
        : recordKey(this.decodeCursor(input.cursor, fingerprint));
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": "IMPORTS", ":prefix": "IMPORT#" },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: input.limit,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    const items = (response.Items ?? []).map(fromItem);
    if (!response.LastEvaluatedKey) return { items };
    const last = items.at(-1);
    if (!last)
      throw new Error("Import pagination returned a cursor without records.");
    const payload = Buffer.from(
      JSON.stringify({ version: 1, importId: last.importId, fingerprint }),
    ).toString("base64url");
    return {
      items,
      cursor: `${payload}.${this.sign(`imports:cursor:${payload}`)}`,
    };
  }

  private update(
    input: ImportPatch,
    nextState?: ImportState,
  ): UpdateCommandInput {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      input.expectedVersion === Number.MAX_SAFE_INTEGER
    )
      throw invalid();
    const names: Record<string, string> = {
      "#state": "state",
      "#version": "version",
    };
    const values: Record<string, unknown> = {
      ":expectedState": input.expectedState,
      ":expectedVersion": input.expectedVersion,
      ":nextVersion": input.expectedVersion + 1,
    };
    const expressions = ["#version = :nextVersion"];
    if (nextState) {
      expressions.push("#state = :nextState");
      values[":nextState"] = nextState;
    }
    Object.entries(input.patch).forEach(([name, value], index) => {
      if (!PATCH_FIELDS.has(name) || value === undefined) throw invalid();
      names[`#p${index}`] = name;
      values[`:p${index}`] = value;
      expressions.push(`#p${index} = :p${index}`);
    });
    return {
      TableName: this.tableName,
      Key: recordKey(input.importId),
      UpdateExpression: `SET ${expressions.join(", ")}`,
      ConditionExpression:
        "attribute_exists(pk) AND #state = :expectedState AND #version = :expectedVersion",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
  }

  private async write(
    input: ImportPatch,
    nextState?: ImportState,
  ): Promise<ImportRecord> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          ...this.update(input, nextState),
          ReturnValues: "ALL_NEW",
        }),
      );
      if (!result.Attributes)
        throw new Error("Import update returned no record.");
      return fromItem(result.Attributes);
    } catch (error) {
      if (namedError(error, "ConditionalCheckFailedException"))
        throw conflict();
      throw error;
    }
  }

  async transition(
    input: ImportPatch & { nextState: ImportState },
  ): Promise<ImportRecord> {
    try {
      assertImportTransition(input.expectedState, input.nextState);
    } catch {
      throw conflict();
    }
    if (!isActiveImportState(input.nextState)) throw conflict();
    return this.write(input, input.nextState);
  }

  async reservePipeline(input: {
    importId: string;
    expectedVersion: number;
    pipelineVersion: ImportPipelineVersion;
    updatedAt: string;
  }): Promise<ImportRecord> {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      input.expectedVersion === Number.MAX_SAFE_INTEGER
    )
      throw invalid();
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: recordKey(input.importId),
          UpdateExpression:
            "SET #pipelineVersion = :pipelineVersion, #updatedAt = :updatedAt, #version = :nextVersion",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(#pipelineVersion) AND #version = :expectedVersion",
          ExpressionAttributeNames: {
            "#pipelineVersion": "pipelineVersion",
            "#updatedAt": "updatedAt",
            "#version": "version",
          },
          ExpressionAttributeValues: {
            ":pipelineVersion": input.pipelineVersion,
            ":updatedAt": input.updatedAt,
            ":expectedVersion": input.expectedVersion,
            ":nextVersion": input.expectedVersion + 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      if (!result.Attributes)
        throw new Error("Pipeline reservation returned no record.");
      return fromItem(result.Attributes);
    } catch (error) {
      if (namedError(error, "ConditionalCheckFailedException"))
        throw conflict();
      throw error;
    }
  }

  async patch(input: ImportPatch): Promise<ImportRecord> {
    if (!isActiveImportState(input.expectedState)) throw conflict();
    return this.write(input);
  }

  private completionReplayCoordinates(
    importId: string,
    input: CompletionReplayInput,
  ) {
    return {
      key: {
        pk: `IMPORT_COMPLETION#${this.sign(
          JSON.stringify([importId, input.idempotencyKey]),
        )}`,
        sk: "COMPLETE",
      },
      fingerprint: this.sign(
        `imports:complete:${JSON.stringify([
          importId,
          input.uploadGeneration,
          input.requestedBy,
          input.parts.map((part) => [
            part.partNumber,
            part.etag,
            part.checksumSha256,
          ]),
        ])}`,
      ),
    };
  }

  async getCompletionReplay(
    importId: string,
    input: CompletionReplayInput,
  ): Promise<ImportRecord | null> {
    const { key, fingerprint } = this.completionReplayCoordinates(
      importId,
      input,
    );
    return this.replay(key, fingerprint);
  }

  private async recoverCompletionWrite(
    error: unknown,
    importId: string,
    replayInput: CompletionReplayInput,
  ): Promise<ImportRecord> {
    try {
      const replay = await this.getCompletionReplay(importId, replayInput);
      if (replay) return replay;
    } catch (replayError) {
      if (
        replayError instanceof ServiceError &&
        replayError.code === "CONFLICT"
      )
        throw replayError;
    }
    if (conditionalReasons(error)) throw conflict();
    throw error;
  }

  async beginCompletion(
    input: ImportPatch,
    replayInput: CompletionReplayInput,
  ): Promise<ImportRecord> {
    if (input.expectedState !== "UPLOADING") throw conflict();
    if (input.patch.completionUploadGeneration !== replayInput.uploadGeneration)
      throw invalid();
    const update = this.update(input);
    update.ConditionExpression += " AND attribute_not_exists(#completion)";
    update.ExpressionAttributeNames!["#completion"] = "completionRequestedAt";
    const { key, fingerprint } = this.completionReplayCoordinates(
      input.importId,
      replayInput,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ...update,
                TableName: this.tableName,
                Key: recordKey(input.importId),
                UpdateExpression: update.UpdateExpression!,
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...key,
                  importId: input.importId,
                  fingerprint,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      return this.recoverCompletionWrite(error, input.importId, replayInput);
    }
    const record = await this.get(input.importId);
    if (!record) throw new Error("Completion intent record is missing.");
    return record;
  }

  async recordCompletionReplay(
    importId: string,
    replayInput: CompletionReplayInput,
  ): Promise<ImportRecord> {
    const { key, fingerprint } = this.completionReplayCoordinates(
      importId,
      replayInput,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: recordKey(importId),
                ConditionExpression:
                  "attribute_exists(pk) AND #owner = :owner AND #generation = :generation",
                ExpressionAttributeNames: {
                  "#owner": "requestedBy",
                  "#generation": "uploadGeneration",
                },
                ExpressionAttributeValues: {
                  ":owner": replayInput.requestedBy,
                  ":generation": replayInput.uploadGeneration,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...key, importId, fingerprint },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      return this.recoverCompletionWrite(error, importId, replayInput);
    }
    const record = await this.get(importId);
    if (!record) throw new Error("Completion replay record is missing.");
    return record;
  }

  private restartKey(importId: string, idempotencyKey: string) {
    return {
      pk: `IMPORT_RESTART#${this.sign(JSON.stringify([importId, idempotencyKey]))}`,
      sk: "RESTART",
    };
  }

  async getRestartReplay(
    importId: string,
    idempotencyKey: string,
  ): Promise<ImportRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.restartKey(importId, idempotencyKey),
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const record = await this.get(importId);
    if (!record)
      throw new Error("Restart mapping references a missing import.");
    return record;
  }

  async recordRestartReplay(
    importId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ImportRecord> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: recordKey(importId),
                ConditionExpression:
                  "attribute_exists(pk) AND #version = :expectedVersion",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: {
                  ":expectedVersion": expectedVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...this.restartKey(importId, idempotencyKey),
                  importId,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditionalReasons(error)) throw error;
      const replay = await this.getRestartReplay(importId, idempotencyKey);
      if (replay) return replay;
      throw conflict();
    }
    const record = await this.get(importId);
    if (!record) throw new Error("Restart replay references a missing import.");
    return record;
  }

  async swapUploadForRestart(
    input: ImportPatch,
    idempotencyKey: string,
  ): Promise<ImportRecord> {
    if (input.expectedState !== "UPLOADING") throw conflict();
    const update = this.update(input);
    update.ConditionExpression += " AND attribute_not_exists(#completion)";
    update.ExpressionAttributeNames!["#completion"] = "completionRequestedAt";
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ...update,
                TableName: this.tableName,
                Key: recordKey(input.importId),
                UpdateExpression: update.UpdateExpression!,
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...this.restartKey(input.importId, idempotencyKey),
                  importId: input.importId,
                  generation: input.patch.uploadGeneration,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (conditionalReasons(error)) throw conflict();
      throw error;
    }
    const record = await this.get(input.importId);
    if (!record) throw new Error("Restarted import record is missing.");
    return record;
  }

  async releaseTerminal(
    importId: string,
    expectedVersion: number,
    state: "READY" | "FAILED",
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ImportRecord> {
    const update = this.update(
      { importId, expectedVersion, expectedState: "PROCESSING", patch },
      state,
    );
    const values = update.ExpressionAttributeValues!;
    delete values[":expectedState"];
    values[":processing"] = "PROCESSING";
    let allowedStates = "#state = :processing";
    if (state === "FAILED") {
      Object.assign(values, {
        ":preparing": "PREPARING",
        ":uploading": "UPLOADING",
        ":uploaded": "UPLOADED",
        ":validating": "VALIDATING",
      });
      allowedStates =
        "#state IN (:preparing, :uploading, :uploaded, :validating, :processing)";
    }
    update.ConditionExpression = `attribute_exists(pk) AND ${allowedStates} AND #version = :expectedVersion`;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ...update,
                TableName: this.tableName,
                Key: recordKey(importId),
                UpdateExpression: update.UpdateExpression!,
              },
            },
            { Delete: this.lockDelete(importId) },
          ],
        }),
      );
    } catch (error) {
      if (conditionalReasons(error)) throw conflict();
      throw error;
    }
    const record = await this.get(importId);
    if (!record) throw new Error("Released import record is missing.");
    return record;
  }

  private lockDelete(importId: string) {
    return {
      TableName: this.tableName,
      Key: ACTIVE_KEY,
      ConditionExpression: "importId = :importId",
      ExpressionAttributeValues: { ":importId": importId },
    };
  }

  async clearActiveLock(importId: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteCommand(this.lockDelete(importId)));
      return true;
    } catch (error) {
      if (namedError(error, "ConditionalCheckFailedException")) return false;
      throw error;
    }
  }

  async tryAcquireReconcileLease(input: {
    owner: string;
    nowEpochSeconds: number;
    expiresAtEpochSeconds: number;
  }): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: RECONCILER_KEY,
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
            ":owner": input.owner,
            ":now": input.nowEpochSeconds,
            ":expiresAt": input.expiresAtEpochSeconds,
            ":ttl": input.expiresAtEpochSeconds + 300,
          },
        }),
      );
      return true;
    } catch (error) {
      if (namedError(error, "ConditionalCheckFailedException")) return false;
      throw error;
    }
  }

  async releaseReconcileLease(owner: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: RECONCILER_KEY,
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (namedError(error, "ConditionalCheckFailedException")) return;
      throw error;
    }
  }
}

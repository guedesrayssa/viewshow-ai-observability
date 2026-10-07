import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

const datasetVersion = `dsv_${"a".repeat(64)}`;
const activeFixture = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/active-dataset-v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const candidate = {
  pk: `CANDIDATE#DATASET#${datasetVersion}`,
  sk: "MANIFEST",
  entityType: "CANDIDATE_MANIFEST",
  candidateDatasetVersion: datasetVersion,
  manifest: structuredClone(activeFixture.manifest),
};

function compareUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => compareUnicode(left, right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function candidateWithMetadata(metadata: Record<string, unknown>) {
  return {
    ...candidate,
    manifest: {
      datasetVersion,
      metadata,
      fingerprint: createHash("sha256")
        .update(canonicalJson({ datasetVersion, metadata }), "utf8")
        .digest("hex"),
    },
  };
}

function canonicalCandidate() {
  const manifest = structuredClone(candidate.manifest) as {
    metadata: Record<string, unknown>;
  };
  const metadata = manifest.metadata;
  const validations = metadata.validations as Record<string, unknown>;
  const parquet = validations.parquetCatalog as Record<string, unknown>;
  parquet.datasets = {
    signal_bucket: {
      partitionCount: 1,
      catalogValidated: true,
      projectionItemCount: 2,
      projectionDigest: "e".repeat(64),
    },
  };
  metadata.hotMaterialization = "SKIPPED";
  metadata.hotItemCount = 0;
  metadata.canonicalMarker = {
    schemaVersion: "1.0",
    objectKey:
      `canonical/schema_version=1.0/dataset_version=${datasetVersion}/` +
      "manifest.json",
    aggregateDigest: "d".repeat(64),
    documentSha256: "f".repeat(64),
    datasetCount: 1,
    partitionCount: 1,
    objectCount: 1,
    totalSourceRows: 1,
    totalAcceptedRows: 1,
    totalRejectedRows: 0,
  };
  return candidateWithMetadata(metadata);
}
const input = {
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  candidateVersion: datasetVersion,
  requestedBy: "usr_reader",
  idempotencyKey: "activate-candidate-1",
  activatedAt: "2026-09-17T10:04:00.000Z",
};

async function moduleUnderTest() {
  return import("../src/modules/imports/adapters/dynamodb-dataset-activation.js");
}

function markerKey() {
  return {
    pk: `DATASET_ACTIVATION_IDEMPOTENCY#${createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex")}`,
    sk: "META",
  };
}

describe("DynamoDB dataset activation", () => {
  it("reads the active pointer consistently and validates its contract", async () => {
    const { DynamoDatasetActivation } = await moduleUnderTest();
    const send = vi.fn(async () => ({ Item: structuredClone(activeFixture) }));
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.getActiveVersion()).resolves.toBe(datasetVersion);
    const command = send.mock.calls[0]![0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: "operational-table",
      Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
      ConsistentRead: true,
    });
  });

  it("atomically activates a validated candidate and writes idempotency plus audit evidence", async () => {
    const { DynamoDatasetActivation } = await moduleUnderTest();
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: candidate })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).resolves.toEqual({
      importId: input.importId,
      datasetVersion,
      activatedAt: input.activatedAt,
      activatedBy: input.requestedBy,
      changed: true,
    });

    expect(send.mock.calls.slice(0, 3).map(([command]) => command)).toEqual([
      expect.any(GetCommand),
      expect.any(GetCommand),
      expect.any(GetCommand),
    ]);
    expect((send.mock.calls[0]![0] as GetCommand).input.Key).toEqual(
      markerKey(),
    );
    expect((send.mock.calls[1]![0] as GetCommand).input.Key).toEqual({
      pk: `CANDIDATE#DATASET#${datasetVersion}`,
      sk: "MANIFEST",
    });
    expect((send.mock.calls[2]![0] as GetCommand).input.Key).toEqual({
      pk: "CONTROL#DATASET",
      sk: "ACTIVE",
    });

    const transaction = send.mock.calls[3]![0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        {
          Put: expect.objectContaining({
            TableName: "operational-table",
            Item: expect.objectContaining({
              pk: "CONTROL#DATASET",
              sk: "ACTIVE",
              entityType: "ACTIVE_MANIFEST",
              activeDatasetVersion: datasetVersion,
              manifest: candidate.manifest,
            }),
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        },
        {
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              pk: "AUDIT#DATASET_ACTIVATION",
              entityType: "DATASET_ACTIVATION_AUDIT",
              importId: input.importId,
              datasetVersion,
              activatedBy: input.requestedBy,
            }),
          }),
        },
      ]),
    );
  });

  it("activates a compact canonical candidate and reflects its marker evidence in ACTIVE", async () => {
    const { DynamoDatasetActivation } = await moduleUnderTest();
    const canonical = canonicalCandidate();
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: canonical })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).resolves.toMatchObject({
      datasetVersion,
      changed: true,
    });

    const transaction = send.mock.calls[3]![0] as TransactWriteCommand;
    const activePut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.pk === "CONTROL#DATASET",
    )?.Put;
    expect(activePut?.Item?.manifest.metadata.canonicalMarker).toEqual(
      canonical.manifest.metadata.canonicalMarker,
    );
    expect(
      activePut?.Item?.manifest.metadata.validations.parquetCatalog.datasets
        .signal_bucket.partitions,
    ).toBeUndefined();
  });

  it.each([
    [
      "missing marker",
      (metadata: Record<string, unknown>) => delete metadata.canonicalMarker,
    ],
    [
      "compact Parquet evidence without canonical top-level evidence",
      (metadata: Record<string, unknown>) => {
        delete metadata.hotMaterialization;
        delete metadata.hotItemCount;
        delete metadata.canonicalMarker;
      },
    ],
    [
      "canonical marker with legacy Parquet evidence",
      (metadata: Record<string, unknown>) => {
        const validations = metadata.validations as Record<string, unknown>;
        const parquet = validations.parquetCatalog as Record<string, unknown>;
        parquet.datasets = {
          signal_bucket: { partitionCount: 1, catalogValidated: true },
        };
      },
    ],
    [
      "partial canonical top-level evidence",
      (metadata: Record<string, unknown>) => {
        delete metadata.canonicalMarker;
        const validations = metadata.validations as Record<string, unknown>;
        const parquet = validations.parquetCatalog as Record<string, unknown>;
        parquet.datasets = {
          signal_bucket: { partitionCount: 1, catalogValidated: true },
        };
      },
    ],
    [
      "an extra top-level field",
      (metadata: Record<string, unknown>) => {
        metadata.representation = "canonical-v2";
      },
    ],
    [
      "wrong marker key",
      (metadata: Record<string, unknown>) => {
        (metadata.canonicalMarker as Record<string, unknown>).objectKey =
          "canonical/other/manifest.json";
      },
    ],
    [
      "invalid marker digest",
      (metadata: Record<string, unknown>) => {
        (metadata.canonicalMarker as Record<string, unknown>).documentSha256 =
          "F".repeat(64);
      },
    ],
    [
      "mismatched marker counts",
      (metadata: Record<string, unknown>) => {
        (metadata.canonicalMarker as Record<string, unknown>).partitionCount =
          2;
      },
    ],
  ])("rejects canonical candidate with %s", async (_name, mutate) => {
    const { DatasetActivationContractError, DynamoDatasetActivation } =
      await moduleUnderTest();
    const canonical = canonicalCandidate();
    const metadata = structuredClone(canonical.manifest.metadata);
    mutate(metadata);
    const malformed = candidateWithMetadata(metadata);
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: malformed });
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).rejects.toBeInstanceOf(
      DatasetActivationContractError,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns the durable replay without writing again", async () => {
    const { DynamoDatasetActivation } = await moduleUnderTest();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.importId,
          input.candidateVersion,
          input.requestedBy,
        ]),
      )
      .digest("hex");
    const replay = {
      ...markerKey(),
      entityType: "DATASET_ACTIVATION_IDEMPOTENCY",
      fingerprint,
      result: {
        importId: input.importId,
        datasetVersion,
        activatedAt: input.activatedAt,
        activatedBy: input.requestedBy,
        changed: true,
      },
      ttl: 1_800_000_000,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: replay })
      .mockResolvedValueOnce({
        Item: {
          pk: `DATASET#${datasetVersion}#INGESTION#PROJECTION_FENCE`,
          sk: "ACTIVE",
          entityType: "ACTIVE_PROJECTION_FENCE",
          datasetVersion,
        },
      });
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).resolves.toEqual(replay.result);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails a durable replay closed when its projection fence is absent", async () => {
    const { DatasetActivationContractError, DynamoDatasetActivation } =
      await moduleUnderTest();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.importId,
          input.candidateVersion,
          input.requestedBy,
        ]),
      )
      .digest("hex");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          ...markerKey(),
          entityType: "DATASET_ACTIVATION_IDEMPOTENCY",
          fingerprint,
          result: {
            importId: input.importId,
            datasetVersion,
            activatedAt: input.activatedAt,
            activatedBy: input.requestedBy,
            changed: true,
          },
          ttl: 1_800_000_000,
        },
      })
      .mockResolvedValueOnce({});
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).rejects.toBeInstanceOf(
      DatasetActivationContractError,
    );
  });

  it("fails closed before writing when the candidate contract is malformed", async () => {
    const { DatasetActivationContractError, DynamoDatasetActivation } =
      await moduleUnderTest();
    const malformed = {
      ...candidate,
      manifest: {
        ...(candidate.manifest as Record<string, unknown>),
        fingerprint: "0".repeat(64),
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: malformed });
    const repository = new DynamoDatasetActivation(
      "us-east-1",
      "operational-table",
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.activate(input)).rejects.toBeInstanceOf(
      DatasetActivationContractError,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});

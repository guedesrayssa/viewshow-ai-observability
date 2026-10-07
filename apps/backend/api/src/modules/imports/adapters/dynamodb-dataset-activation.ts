import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { datasetVersionSchema, importIdSchema } from "@view-show/contracts";
import { z } from "zod";
import {
  ActiveDatasetContractError,
  decodeActiveDatasetItem,
} from "../../datasets/domain/active-dataset.js";
import {
  DatasetActivationConflictError,
  DatasetActivationContractError,
  type DatasetActivationInput,
  type DatasetActivationPort,
  type DatasetActivationResult,
} from "../ports/dataset-activation.js";

const ACTIVE_KEY = { pk: "CONTROL#DATASET", sk: "ACTIVE" } as const;
const IDEMPOTENCY_TTL_SECONDS = 90 * 24 * 60 * 60;
const SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_METADATA_FIELDS = [
  "availableIntervals",
  "canonicalSchemaVersion",
  "coverage",
  "descriptorVersions",
  "dumpChecksumSha256",
  "formulaVersions",
  "glueTables",
  "hotFrom",
  "physicalContractVersion",
  "projectionVersions",
  "qualityFlags",
  "s3Prefix",
  "snapshotExtractedOn",
  "validations",
  "watermarks",
] as const;
const CANONICAL_METADATA_FIELDS = [
  ...LEGACY_METADATA_FIELDS,
  "canonicalMarker",
  "hotItemCount",
  "hotMaterialization",
] as const;
const CANONICAL_MARKER_FIELDS = [
  "aggregateDigest",
  "datasetCount",
  "documentSha256",
  "objectCount",
  "objectKey",
  "partitionCount",
  "schemaVersion",
  "totalAcceptedRows",
  "totalRejectedRows",
  "totalSourceRows",
] as const;
const activationResultSchema = z
  .object({
    importId: importIdSchema,
    datasetVersion: datasetVersionSchema,
    activatedAt: z.iso.datetime({ offset: true, precision: 3 }),
    activatedBy: z.string().trim().min(1).max(256),
    changed: z.boolean(),
  })
  .strict();

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inputFingerprint(input: DatasetActivationInput): string {
  return hash(
    JSON.stringify([input.importId, input.candidateVersion, input.requestedBy]),
  );
}

function markerKey(idempotencyKey: string) {
  return {
    pk: `DATASET_ACTIVATION_IDEMPOTENCY#${hash(idempotencyKey)}`,
    sk: "META",
  };
}

function projectionFenceKey(datasetVersion: string) {
  return {
    pk: `DATASET#${datasetVersion}#INGESTION#PROJECTION_FENCE`,
    sk: "ACTIVE",
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DatasetActivationContractError();
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new DatasetActivationContractError();
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function validateCanonicalEvidence(
  metadata: Record<string, unknown>,
  validations: Record<string, unknown>,
  expectedVersion: string,
) {
  const isLegacy = exactKeys(metadata, LEGACY_METADATA_FIELDS);
  const isCanonical = exactKeys(metadata, CANONICAL_METADATA_FIELDS);
  if (!isLegacy && !isCanonical) throw new DatasetActivationContractError();
  const parquetDatasets = object(object(validations.parquetCatalog).datasets);
  if (isLegacy) {
    for (const rawEvidence of Object.values(parquetDatasets)) {
      const evidence = object(rawEvidence);
      const isMinimal = exactKeys(evidence, [
        "catalogValidated",
        "partitionCount",
      ]);
      const isGranular = exactKeys(evidence, [
        "catalogValidated",
        "partitionCount",
        "partitions",
      ]);
      const partitionCount = nonNegativeInteger(evidence.partitionCount);
      if (!isMinimal && !isGranular) throw new DatasetActivationContractError();
      if (!isGranular) continue;
      const partitions = object(evidence.partitions);
      if (Object.keys(partitions).length !== partitionCount)
        throw new DatasetActivationContractError();
      for (const partition of Object.values(partitions)) {
        const counts = object(partition);
        if (!exactKeys(counts, ["projectionItemCount"]))
          throw new DatasetActivationContractError();
        nonNegativeInteger(counts.projectionItemCount);
      }
    }
    return;
  }
  if (metadata.hotMaterialization !== "SKIPPED" || metadata.hotItemCount !== 0)
    throw new DatasetActivationContractError();

  const marker = object(metadata.canonicalMarker);
  if (!exactKeys(marker, CANONICAL_MARKER_FIELDS))
    throw new DatasetActivationContractError();
  if (
    typeof metadata.canonicalSchemaVersion !== "string" ||
    marker.schemaVersion !== metadata.canonicalSchemaVersion ||
    marker.objectKey !==
      `canonical/schema_version=1.0/dataset_version=${expectedVersion}/manifest.json` ||
    typeof marker.aggregateDigest !== "string" ||
    !SHA256.test(marker.aggregateDigest) ||
    typeof marker.documentSha256 !== "string" ||
    !SHA256.test(marker.documentSha256)
  )
    throw new DatasetActivationContractError();

  const reconciliationDatasets = object(
    object(validations.reconciliation).datasets,
  );
  const datasetNames = Object.keys(parquetDatasets).sort();
  if (
    datasetNames.length !== nonNegativeInteger(marker.datasetCount) ||
    JSON.stringify(datasetNames) !==
      JSON.stringify(Object.keys(reconciliationDatasets).sort())
  )
    throw new DatasetActivationContractError();

  let partitionCount = 0;
  let totalAcceptedRows = 0;
  let totalRejectedRows = 0;
  let totalPersistedRows = 0;
  for (const dataset of datasetNames) {
    const parquet = object(parquetDatasets[dataset]);
    if (
      !exactKeys(parquet, [
        "catalogValidated",
        "partitionCount",
        "projectionDigest",
        "projectionItemCount",
      ]) ||
      parquet.catalogValidated !== true ||
      typeof parquet.projectionDigest !== "string" ||
      !SHA256.test(parquet.projectionDigest)
    )
      throw new DatasetActivationContractError();
    partitionCount += nonNegativeInteger(parquet.partitionCount);
    nonNegativeInteger(parquet.projectionItemCount);

    const reconciliation = object(reconciliationDatasets[dataset]);
    if (!exactKeys(reconciliation, ["accepted", "persisted", "rejected"]))
      throw new DatasetActivationContractError();
    totalAcceptedRows += nonNegativeInteger(reconciliation.accepted);
    totalRejectedRows += nonNegativeInteger(reconciliation.rejected);
    totalPersistedRows += nonNegativeInteger(reconciliation.persisted);
  }

  const objectCount = nonNegativeInteger(marker.objectCount);
  const sourceRows = nonNegativeInteger(marker.totalSourceRows);
  if (
    nonNegativeInteger(marker.partitionCount) !== partitionCount ||
    objectCount < partitionCount ||
    nonNegativeInteger(marker.totalAcceptedRows) !== totalAcceptedRows ||
    nonNegativeInteger(marker.totalRejectedRows) !== totalRejectedRows ||
    sourceRows !== totalAcceptedRows + totalRejectedRows ||
    totalPersistedRows !== totalAcceptedRows
  )
    throw new DatasetActivationContractError();
}

function candidateManifest(
  item: unknown,
  expectedVersion: string,
): Record<string, unknown> {
  const candidate = object(item);
  if (
    Object.keys(candidate).length !== 5 ||
    candidate.pk !== `CANDIDATE#DATASET#${expectedVersion}` ||
    candidate.sk !== "MANIFEST" ||
    candidate.entityType !== "CANDIDATE_MANIFEST" ||
    candidate.candidateDatasetVersion !== expectedVersion
  )
    throw new DatasetActivationContractError();
  try {
    decodeActiveDatasetItem({
      pk: ACTIVE_KEY.pk,
      sk: ACTIVE_KEY.sk,
      entityType: "ACTIVE_MANIFEST",
      activeDatasetVersion: expectedVersion,
      manifest: candidate.manifest,
    });
  } catch (error) {
    if (error instanceof ActiveDatasetContractError)
      throw new DatasetActivationContractError();
    throw error;
  }

  const manifest = object(candidate.manifest);
  const metadata = object(manifest.metadata);
  const validations = object(metadata.validations);
  const required = [
    "coverageQuality",
    "parquetCatalog",
    "physicalSchemas",
    "reconciliation",
    "requiredProjections",
  ];
  if (
    JSON.stringify(Object.keys(validations).sort()) !==
      JSON.stringify(required) ||
    !Object.values(validations).every(
      (validation) => object(validation).state === "PASSED",
    ) ||
    Object.values(object(metadata.coverage)).some(
      (coverage) => coverage === "UNAVAILABLE",
    ) ||
    !Object.values(object(object(validations.physicalSchemas).datasets)).every(
      (evidence) => object(evidence).compatible === true,
    ) ||
    !Object.values(object(object(validations.parquetCatalog).datasets)).every(
      (evidence) => object(evidence).catalogValidated === true,
    )
  )
    throw new DatasetActivationContractError();
  validateCanonicalEvidence(metadata, validations, expectedVersion);
  return manifest;
}

export { DatasetActivationContractError } from "../ports/dataset-activation.js";

export class DynamoDatasetActivation implements DatasetActivationPort {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    region: string,
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
    endpoint?: string,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region,
          ...(endpoint ? { endpoint } : {}),
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  private async get(key: { pk: string; sk: string }) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
  }

  async getActiveVersion(): Promise<string | null> {
    const item = await this.get(ACTIVE_KEY);
    if (!item) return null;
    try {
      return decodeActiveDatasetItem(item).datasetVersion;
    } catch (error) {
      if (error instanceof ActiveDatasetContractError)
        throw new DatasetActivationContractError();
      throw error;
    }
  }

  private async replay(
    input: DatasetActivationInput,
  ): Promise<DatasetActivationResult | null> {
    const item = await this.get(markerKey(input.idempotencyKey));
    if (!item) return null;
    const marker = object(item);
    if (
      marker.entityType !== "DATASET_ACTIVATION_IDEMPOTENCY" ||
      marker.fingerprint !== inputFingerprint(input)
    )
      throw new DatasetActivationConflictError();
    const parsed = activationResultSchema.safeParse(marker.result);
    if (
      !parsed.success ||
      parsed.data.importId !== input.importId ||
      parsed.data.datasetVersion !== input.candidateVersion ||
      parsed.data.activatedBy !== input.requestedBy
    )
      throw new DatasetActivationContractError();
    const fence = await this.get(
      projectionFenceKey(parsed.data.datasetVersion),
    );
    if (
      !fence ||
      Object.keys(fence).length !== 4 ||
      fence.pk !== projectionFenceKey(parsed.data.datasetVersion).pk ||
      fence.sk !== "ACTIVE" ||
      fence.entityType !== "ACTIVE_PROJECTION_FENCE" ||
      fence.datasetVersion !== parsed.data.datasetVersion
    )
      throw new DatasetActivationContractError();
    return parsed.data;
  }

  async activate(
    input: DatasetActivationInput,
  ): Promise<DatasetActivationResult> {
    const parsedInput = {
      ...input,
      importId: importIdSchema.parse(input.importId),
      candidateVersion: datasetVersionSchema.parse(input.candidateVersion),
      requestedBy: z.string().trim().min(1).max(256).parse(input.requestedBy),
      idempotencyKey: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .parse(input.idempotencyKey),
      activatedAt: z.iso
        .datetime({ offset: true, precision: 3 })
        .parse(input.activatedAt),
    };
    const replay = await this.replay(parsedInput);
    if (replay) return replay;

    const candidate = await this.get({
      pk: `CANDIDATE#DATASET#${parsedInput.candidateVersion}`,
      sk: "MANIFEST",
    });
    if (!candidate) throw new DatasetActivationContractError();
    const manifest = candidateManifest(candidate, parsedInput.candidateVersion);
    const activeItem = await this.get(ACTIVE_KEY);
    let expectedActive: string | null = null;
    if (activeItem) {
      try {
        expectedActive = decodeActiveDatasetItem(activeItem).datasetVersion;
      } catch (error) {
        if (error instanceof ActiveDatasetContractError)
          throw new DatasetActivationContractError();
        throw error;
      }
    }
    const result: DatasetActivationResult = {
      importId: parsedInput.importId,
      datasetVersion: parsedInput.candidateVersion,
      activatedAt: parsedInput.activatedAt,
      activatedBy: parsedInput.requestedBy,
      changed: expectedActive !== parsedInput.candidateVersion,
    };
    const fingerprint = inputFingerprint(parsedInput);
    const key = markerKey(parsedInput.idempotencyKey);
    const ttl =
      Math.floor(Date.parse(parsedInput.activatedAt) / 1000) +
      IDEMPOTENCY_TTL_SECONDS;
    const fingerprintValue = object(manifest).fingerprint;
    if (typeof fingerprintValue !== "string")
      throw new DatasetActivationContractError();

    const activePut = {
      TableName: this.tableName,
      Item: {
        ...ACTIVE_KEY,
        entityType: "ACTIVE_MANIFEST",
        activeDatasetVersion: parsedInput.candidateVersion,
        manifest,
      },
      ConditionExpression: expectedActive
        ? "activeDatasetVersion = :expectedActive"
        : "attribute_not_exists(pk)",
      ...(expectedActive
        ? { ExpressionAttributeValues: { ":expectedActive": expectedActive } }
        : {}),
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  pk: `CANDIDATE#DATASET#${parsedInput.candidateVersion}`,
                  sk: "MANIFEST",
                },
                ConditionExpression:
                  "candidateDatasetVersion = :candidateVersion AND manifest.fingerprint = :candidateFingerprint",
                ExpressionAttributeValues: {
                  ":candidateVersion": parsedInput.candidateVersion,
                  ":candidateFingerprint": fingerprintValue,
                },
              },
            },
            { Put: activePut },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...projectionFenceKey(parsedInput.candidateVersion),
                  entityType: "ACTIVE_PROJECTION_FENCE",
                  datasetVersion: parsedInput.candidateVersion,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) OR datasetVersion = :candidateVersion",
                ExpressionAttributeValues: {
                  ":candidateVersion": parsedInput.candidateVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...key,
                  entityType: "DATASET_ACTIVATION_IDEMPOTENCY",
                  fingerprint,
                  result,
                  ttl,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "AUDIT#DATASET_ACTIVATION",
                  sk: `AT#${parsedInput.activatedAt}#ID#${hash(parsedInput.idempotencyKey)}`,
                  entityType: "DATASET_ACTIVATION_AUDIT",
                  importId: parsedInput.importId,
                  datasetVersion: parsedInput.candidateVersion,
                  previousDatasetVersion: expectedActive,
                  activatedBy: parsedInput.requestedBy,
                  activatedAt: parsedInput.activatedAt,
                  changed: result.changed,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TransactionCanceledException" ||
          error.name === "ConditionalCheckFailedException")
      ) {
        const committed = await this.replay(parsedInput);
        if (committed) return committed;
        throw new DatasetActivationConflictError();
      }
      throw error;
    }
  }
}

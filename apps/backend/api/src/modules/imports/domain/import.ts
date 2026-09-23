import {
  importIdSchema,
  importRunStageSchema,
  type ImportRunStage,
  type ImportSafeError,
  type ImportSnapshot,
  type ImportState,
} from "@view-show/contracts";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

const ALLOWED: Readonly<Record<ImportState, readonly ImportState[]>> = {
  PREPARING: ["UPLOADING", "FAILED"],
  UPLOADING: ["UPLOADED", "FAILED"],
  UPLOADED: ["VALIDATING", "FAILED"],
  VALIDATING: ["PROCESSING", "FAILED"],
  PROCESSING: ["READY", "FAILED"],
  READY: [],
  FAILED: [],
};

export type ImportProgress =
  | { kind: "bytes"; completedBytes: number; totalBytes: number }
  | {
      kind: "stage";
      stage: string;
      substage?: string;
      stageStartedAt?: string;
      heartbeatAt?: string;
      recordsRead: number;
      recordsWritten: number;
      recordsRejected: number;
      recordsTotal?: number | null;
      currentDataset?: string | null;
      currentPartition?: string;
      datasetsCompleted?: number;
      datasetsTotal?: number;
      unitsCompleted?: number;
      unitsTotal?: number;
      unitLabel?: string;
    }
  | { kind: "none" };

export type ImportPipelineVersion = "legacy-v1" | "canonical-v2";

export function decodeImportPipelineVersion(
  pipelineVersion: ImportPipelineVersion | undefined,
): ImportPipelineVersion {
  return pipelineVersion ?? "legacy-v1";
}

type LegacyStoredImportError = Omit<
  ImportSafeError,
  "stage" | "retryable" | "attempt" | "maxAttempts"
>;
type StoredImportError = LegacyStoredImportError | ImportSafeError;

const PUBLIC_IMPORT_FAILURE_MESSAGES: Readonly<
  Partial<Record<ImportSafeError["code"], string>>
> = {
  MYSQL_CONNECTION_LOST:
    "A conexão com o MySQL foi perdida após as tentativas de reconexão.",
  MYSQL_QUERY_TIMEOUT:
    "A consulta ao MySQL excedeu o tempo limite após novas tentativas.",
  QUERY_PLAN_INVALID:
    "O plano de consulta do MySQL não permite uma importação segura.",
  ARCHIVE_PUBLICATION_FAILED:
    "Não foi possível publicar o arquivo canônico. Tente novamente.",
  DYNAMODB_THROTTLED:
    "O armazenamento de controle está temporariamente sobrecarregado. Tente novamente.",
  DISK_PRESSURE:
    "Não há espaço temporário suficiente para concluir a importação.",
  CHECKSUM_MISMATCH:
    "A integridade dos dados da importação não pôde ser confirmada.",
  SOURCE_SCHEMA_INVALID: "O esquema ou a cobertura da origem é incompatível.",
  DATA_RECONCILIATION_FAILED:
    "As evidências publicadas não reconciliam com os dados importados.",
};

function publicImportFailureMessage(code: ImportSafeError["code"]): string {
  return (
    PUBLIC_IMPORT_FAILURE_MESSAGES[code] ??
    "Não foi possível concluir a importação."
  );
}

function publicRunStage(stage: string): ImportRunStage {
  const current = importRunStageSchema.safeParse(stage);
  if (current.success) return current.data;
  const legacy = {
    validating: "VALIDATING",
    processing: "INGESTING",
    published: "PUBLISHING",
  } as const;
  return importRunStageSchema.parse(legacy[stage as keyof typeof legacy]);
}

export type ImportRecord = Omit<
  ImportSnapshot,
  "canManageUpload" | "progress" | "error"
> & {
  progress: ImportProgress;
  error: StoredImportError | null;
  bucket: string;
  key: string;
  uploadId: string | null;
  taskArn: string | null;
  physicalVersion: string | null;
  partSizeBytes?: number;
  expectedPartCount?: number;
  uploadGeneration?: number;
  uploadExpiresAt?: string;
  completionRequestedAt?: string;
  completionUploadGeneration?: number;
  progressRunStage?: string;
  pipelineVersion?: ImportPipelineVersion;
};

/** Creates an opaque, lexicographically sortable ULID-backed import identifier. */
export function createImportId(now: Date, entropy: Uint8Array): string {
  const timestamp = now.getTime();
  if (
    !Number.isInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_ULID_TIMESTAMP
  ) {
    throw new RangeError("ULID timestamp must fit in 48 bits.");
  }
  if (entropy.byteLength !== 10) {
    throw new RangeError("ULID entropy must contain exactly 10 bytes.");
  }

  let value = BigInt(timestamp);
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);

  const encoded = Array<string>(26);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32[Number(value & 31n)]!;
    value >>= 5n;
  }
  return `imp_${encoded.join("")}`;
}

export function isActiveImportState(state: ImportState): boolean {
  return state !== "READY" && state !== "FAILED";
}

export function importRequestId(importId: string): string {
  return `req_import_${importIdSchema.parse(importId).slice(4)}`;
}

export function assertImportTransition(
  from: ImportState,
  to: ImportState,
): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`Invalid import transition: ${from} -> ${to}`);
  }
}

export function toPublicImport(
  record: ImportRecord,
  viewerId: string,
): ImportSnapshot {
  return {
    importId: record.importId,
    requestedBy: record.requestedBy,
    author: {
      id: record.author.id,
      name: record.author.name,
      email: record.author.email,
    },
    canManageUpload:
      record.requestedBy === viewerId && isActiveImportState(record.state),
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    snapshotExtractedOn: record.snapshotExtractedOn,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    version: record.version,
    progress: toPublicProgress(record.progress),
    candidateVersion: record.candidateVersion,
    error:
      record.error === null
        ? null
        : {
            code: record.error.code,
            message: publicImportFailureMessage(record.error.code),
            requestId: record.error.requestId,
            stage: "stage" in record.error ? record.error.stage : null,
            retryable:
              "retryable" in record.error ? record.error.retryable : false,
            attempt: "attempt" in record.error ? record.error.attempt : 1,
            maxAttempts:
              "maxAttempts" in record.error ? record.error.maxAttempts : null,
          },
  };
}

function toPublicProgress(
  progress: ImportProgress,
): ImportSnapshot["progress"] {
  switch (progress.kind) {
    case "bytes":
      return {
        kind: "bytes",
        completedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
      };
    case "stage":
      return {
        kind: "stage",
        stage: publicRunStage(progress.stage),
        ...(progress.substage === undefined
          ? {}
          : { substage: progress.substage }),
        ...(progress.stageStartedAt === undefined
          ? {}
          : { stageStartedAt: progress.stageStartedAt }),
        ...(progress.heartbeatAt === undefined
          ? {}
          : { heartbeatAt: progress.heartbeatAt }),
        recordsRead: progress.recordsRead,
        recordsWritten: progress.recordsWritten,
        recordsRejected: progress.recordsRejected,
        ...(progress.recordsTotal === undefined
          ? {}
          : { recordsTotal: progress.recordsTotal }),
        ...(progress.currentDataset === undefined
          ? {}
          : { currentDataset: progress.currentDataset }),
        ...(progress.currentPartition === undefined
          ? {}
          : { currentPartition: progress.currentPartition }),
        ...(progress.datasetsCompleted === undefined
          ? {}
          : { datasetsCompleted: progress.datasetsCompleted }),
        ...(progress.datasetsTotal === undefined
          ? {}
          : { datasetsTotal: progress.datasetsTotal }),
        ...(progress.unitsCompleted === undefined
          ? {}
          : { unitsCompleted: progress.unitsCompleted }),
        ...(progress.unitsTotal === undefined
          ? {}
          : { unitsTotal: progress.unitsTotal }),
        ...(progress.unitLabel === undefined
          ? {}
          : { unitLabel: progress.unitLabel }),
      };
    case "none":
      return { kind: "none" };
  }
}

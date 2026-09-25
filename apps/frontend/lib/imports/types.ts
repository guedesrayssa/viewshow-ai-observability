export type ImportState =
  | "PREPARING"
  | "UPLOADING"
  | "UPLOADED"
  | "VALIDATING"
  | "PROCESSING"
  | "READY"
  | "FAILED";

export type ImportRunStage =
  | "STARTING"
  | "RESTORING"
  | "VALIDATING"
  | "INGESTING"
  | "EXTRACTING"
  | "PROJECTING"
  | "ARCHIVING"
  | "ACTIVATING"
  | "MATERIALIZING_HOT"
  | "FINALIZING_CANDIDATE"
  | "PUBLISHING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED_LOCKED"
  | "SKIPPED_DISABLED";

export type ImportProgress =
  | { kind: "bytes"; completedBytes: number; totalBytes: number }
  | {
      kind: "stage";
      stage: ImportRunStage;
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

export type ImportSnapshot = {
  importId: string;
  requestedBy: string;
  author: { id: string; name: string | null; email: string | null };
  canManageUpload: boolean;
  fileName: string;
  sizeBytes: number;
  snapshotExtractedOn: string;
  createdAt: string;
  updatedAt: string;
  state: ImportState;
  version: number;
  progress: ImportProgress;
  candidateVersion: string | null;
  error: {
    code: string;
    message: string;
    requestId: string;
    stage: string | null;
    retryable: boolean;
    attempt: number;
    maxAttempts: number | null;
  } | null;
};

export type ImportPage = {
  items: ImportSnapshot[];
  cursor: string | null;
  activeDatasetVersion?: string | null;
};

export type DatasetActivation = {
  importId: string;
  datasetVersion: string;
  activatedAt: string;
  activatedBy: string;
  changed: boolean;
};

export type ImportPart = {
  partNumber: number;
  etag: string;
  checksumSha256: string;
  sizeBytes: number;
};

export type SignedImportPart = {
  partNumber: number;
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
};

export type UploadProgress = {
  confirmedBytes: number;
  inFlightBytes: number;
  totalBytes: number;
};

export type ImportFile = Pick<File, "name" | "size" | "slice">;

const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/;
const IMPORT_ID = /^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DATASET_VERSION = /^dsv_[0-9a-f]{64}$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;
const ZIP_FILE_NAME = /^[^/\\]{1,251}\.zip$/i;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMPORT_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "CONFLICT",
  "REVIEW_VERSION_CONFLICT",
  "DIAGNOSIS_NOT_READY",
  "HYPOTHESIS_SUPERSEDED",
  "UNSUPPORTED_FILTER_COMBINATION",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "DATA_UNAVAILABLE",
  "FEATURE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "IMPORT_IN_PROGRESS",
  "IMPORT_NOT_OWNED",
  "IMPORT_STATE_CONFLICT",
  "IMPORT_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "UPLOAD_PREPARATION_FAILED",
  "WORKER_STOPPED",
  "MYSQL_CONNECTION_LOST",
  "MYSQL_QUERY_TIMEOUT",
  "QUERY_PLAN_INVALID",
  "ARCHIVE_PUBLICATION_FAILED",
  "DYNAMODB_THROTTLED",
  "DISK_PRESSURE",
  "CHECKSUM_MISMATCH",
  "SOURCE_SCHEMA_INVALID",
  "DATA_RECONCILIATION_FAILED",
]);

function contractError(): Error {
  return new Error("A API devolveu dados de importação fora do contrato.");
}

function record(
  value: unknown,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw contractError();
  const result = Object.fromEntries(Object.entries(value));
  if (
    allowedKeys &&
    Object.keys(result).some((key) => !allowedKeys.includes(key))
  )
    throw contractError();
  return result;
}

function text(value: unknown, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string") throw contractError();
  const result = value.trim();
  if (result.length === 0 || result.length > maximum) throw contractError();
  return result;
}

function nullableText(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): string | null {
  return value === null ? null : text(value, maximum);
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < minimum ||
    value > maximum
  )
    throw contractError();
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw contractError();
  return value;
}

function parseState(value: unknown): ImportState {
  switch (value) {
    case "PREPARING":
    case "UPLOADING":
    case "UPLOADED":
    case "VALIDATING":
    case "PROCESSING":
    case "READY":
    case "FAILED":
      return value;
    default:
      throw contractError();
  }
}

function parseRunStage(value: unknown): ImportRunStage {
  switch (value) {
    case "STARTING":
    case "RESTORING":
    case "VALIDATING":
    case "INGESTING":
    case "EXTRACTING":
    case "PROJECTING":
    case "ARCHIVING":
    case "ACTIVATING":
    case "MATERIALIZING_HOT":
    case "FINALIZING_CANDIDATE":
    case "PUBLISHING":
    case "SUCCEEDED":
    case "PARTIAL":
    case "FAILED":
    case "SKIPPED_LOCKED":
    case "SKIPPED_DISABLED":
      return value;
    default:
      throw contractError();
  }
}

function parseProgress(value: unknown): ImportProgress {
  const item = record(value);
  if (item.kind === "none") {
    record(value, ["kind"]);
    return { kind: "none" };
  }
  if (item.kind === "bytes") {
    record(value, ["kind", "completedBytes", "totalBytes"]);
    const completedBytes = integer(item.completedBytes);
    const totalBytes = integer(item.totalBytes, 1);
    if (completedBytes > totalBytes) throw contractError();
    return { kind: "bytes", completedBytes, totalBytes };
  }
  if (item.kind === "stage") {
    const allowed = [
      "kind",
      "stage",
      "substage",
      "stageStartedAt",
      "heartbeatAt",
      "recordsRead",
      "recordsWritten",
      "recordsRejected",
      "recordsTotal",
      "currentDataset",
      "currentPartition",
      "datasetsCompleted",
      "datasetsTotal",
      "unitsCompleted",
      "unitsTotal",
      "unitLabel",
    ] as const;
    record(value, allowed);
    const detailKeys = [
      "stageStartedAt",
      "heartbeatAt",
      "recordsTotal",
      "currentDataset",
      "datasetsCompleted",
      "datasetsTotal",
    ] as const;
    const detailsPresent = detailKeys.filter((key) => key in item).length;
    if (detailsPresent !== 0 && detailsPresent !== detailKeys.length)
      throw contractError();
    const base = {
      kind: "stage" as const,
      stage: parseRunStage(item.stage),
      recordsRead: integer(item.recordsRead),
      recordsWritten: integer(item.recordsWritten),
      recordsRejected: integer(item.recordsRejected),
    };
    const units = ["unitsCompleted", "unitsTotal", "unitLabel"] as const;
    const unitsPresent = units.filter((key) => key in item).length;
    if (unitsPresent !== 0 && unitsPresent !== units.length)
      throw contractError();
    const optional = {
      ...(item.substage === undefined
        ? {}
        : { substage: text(item.substage, 128) }),
      ...(item.currentPartition === undefined
        ? {}
        : { currentPartition: text(item.currentPartition, 128) }),
    };
    let unitProgress: {
      unitsCompleted?: number;
      unitsTotal?: number;
      unitLabel?: string;
    } = {};
    if (unitsPresent !== 0) {
      const unitsCompleted = integer(item.unitsCompleted);
      const unitsTotal = integer(item.unitsTotal);
      if (unitsCompleted > unitsTotal) throw contractError();
      unitProgress = {
        unitsCompleted,
        unitsTotal,
        unitLabel: text(item.unitLabel, 128),
      };
    }
    if (detailsPresent === 0) return { ...base, ...optional, ...unitProgress };
    const stageStartedAt = timestamp(item.stageStartedAt);
    const heartbeatAt = timestamp(item.heartbeatAt);
    if (Date.parse(heartbeatAt) < Date.parse(stageStartedAt))
      throw contractError();
    const datasetsCompleted = integer(item.datasetsCompleted);
    const datasetsTotal = integer(item.datasetsTotal);
    if (datasetsCompleted > datasetsTotal) throw contractError();
    const recordsTotal =
      item.recordsTotal === null ? null : integer(item.recordsTotal);
    if (recordsTotal !== null && base.recordsRead > recordsTotal)
      throw contractError();
    return {
      ...base,
      ...optional,
      ...unitProgress,
      stageStartedAt,
      heartbeatAt,
      recordsTotal,
      currentDataset:
        item.currentDataset === null ? null : text(item.currentDataset, 128),
      datasetsCompleted,
      datasetsTotal,
    };
  }
  throw contractError();
}

function civilDateParts(
  value: string,
): readonly [string, string, string] | null {
  const match = CIVIL_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > daysByMonth[month - 1]!) return null;
  return [match[1]!, match[2]!, match[3]!];
}

function civilDate(value: unknown): string {
  const result = text(value);
  if (result !== value || !civilDateParts(result)) throw contractError();
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (!ISO_TIMESTAMP.test(result) || !Number.isFinite(Date.parse(result)))
    throw contractError();
  return result;
}

function fileName(value: unknown): string {
  if (value === "argus_dump.sql.gz") return value;
  const result = text(value);
  if (!ZIP_FILE_NAME.test(result)) throw contractError();
  return result;
}

function candidateVersion(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  if (!DATASET_VERSION.test(result)) throw contractError();
  return result;
}

export function parseImportSnapshot(value: unknown): ImportSnapshot {
  const item = record(value, [
    "importId",
    "requestedBy",
    "author",
    "canManageUpload",
    "fileName",
    "sizeBytes",
    "snapshotExtractedOn",
    "createdAt",
    "updatedAt",
    "state",
    "version",
    "progress",
    "candidateVersion",
    "error",
  ]);
  const state = parseState(item.state);
  const importId = text(item.importId);
  if (!IMPORT_ID.test(importId)) throw contractError();
  const author = record(item.author, ["id", "name", "email"]);
  const safeError = item.error === null ? null : record(item.error);
  if (safeError !== null) {
    const keys = Object.keys(safeError);
    const legacy = ["code", "message", "requestId"];
    const current = [...legacy, "stage", "retryable", "attempt", "maxAttempts"];
    if (
      ![legacy, current].some(
        (allowed) =>
          keys.length === allowed.length &&
          keys.every((key) => allowed.includes(key)),
      )
    )
      throw contractError();
  }
  const email = nullableText(author.email, 320);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw contractError();
  if (
    safeError !== null &&
    (!IMPORT_ERROR_CODES.has(text(safeError.code)) ||
      !SAFE_REQUEST_ID.test(text(safeError.requestId)))
  )
    throw contractError();
  const errorStage =
    safeError === null || !("stage" in safeError)
      ? null
      : nullableText(safeError.stage, 128);
  const errorRetryable =
    safeError === null || !("retryable" in safeError)
      ? false
      : flag(safeError.retryable);
  const errorAttempt =
    safeError === null || !("attempt" in safeError)
      ? 1
      : integer(safeError.attempt, 1);
  const errorMaxAttempts =
    safeError === null || !("maxAttempts" in safeError)
      ? null
      : safeError.maxAttempts === null
        ? null
        : integer(safeError.maxAttempts, 1);
  if (errorMaxAttempts !== null && errorAttempt > errorMaxAttempts)
    throw contractError();
  return {
    importId,
    requestedBy: text(item.requestedBy, 256),
    author: {
      id: text(author.id, 256),
      name: nullableText(author.name, 256),
      email,
    },
    canManageUpload: flag(item.canManageUpload),
    fileName: fileName(item.fileName),
    sizeBytes: integer(item.sizeBytes, 1),
    snapshotExtractedOn: civilDate(item.snapshotExtractedOn),
    createdAt: timestamp(item.createdAt),
    updatedAt: timestamp(item.updatedAt),
    state,
    version: integer(item.version),
    progress: parseProgress(item.progress),
    candidateVersion: candidateVersion(item.candidateVersion),
    error:
      safeError === null
        ? null
        : {
            code: text(safeError.code),
            message: text(safeError.message, 1000),
            requestId: text(safeError.requestId),
            stage: errorStage,
            retryable: errorRetryable,
            attempt: errorAttempt,
            maxAttempts: errorMaxAttempts,
          },
  };
}

export function parseImportPage(value: unknown): ImportPage {
  const item = record(value, ["items", "cursor", "activeDatasetVersion"]);
  if (!Array.isArray(item.items)) throw contractError();
  return {
    items: item.items.map(parseImportSnapshot),
    cursor: nullableText(item.cursor, 2048),
    ...(item.activeDatasetVersion === undefined
      ? {}
      : { activeDatasetVersion: candidateVersion(item.activeDatasetVersion) }),
  };
}

export function parseDatasetActivation(value: unknown): DatasetActivation {
  const item = record(value, [
    "importId",
    "datasetVersion",
    "activatedAt",
    "activatedBy",
    "changed",
  ]);
  const importId = text(item.importId);
  const datasetVersion = candidateVersion(item.datasetVersion);
  if (!IMPORT_ID.test(importId) || datasetVersion === null)
    throw contractError();
  return {
    importId,
    datasetVersion,
    activatedAt: timestamp(item.activatedAt),
    activatedBy: text(item.activatedBy, 256),
    changed: flag(item.changed),
  };
}

function parseImportPart(value: unknown): ImportPart {
  const item = record(value, [
    "partNumber",
    "etag",
    "checksumSha256",
    "sizeBytes",
  ]);
  const checksumSha256 = text(item.checksumSha256);
  if (!CHECKSUM.test(checksumSha256)) throw contractError();
  return {
    partNumber: integer(item.partNumber, 1, 10_000),
    etag: text(item.etag, 1024),
    checksumSha256,
    sizeBytes: integer(item.sizeBytes, 1),
  };
}

export function parseImportParts(value: unknown): ImportPart[] {
  const item = record(value, ["parts"]);
  if (!Array.isArray(item.parts)) throw contractError();
  return item.parts.map(parseImportPart);
}

function stringRecord(value: unknown): Record<string, string> {
  const item = record(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(item)) {
    if (typeof entry !== "string") throw contractError();
    result[key] = entry;
  }
  return result;
}

function absoluteUrl(value: unknown): string {
  const result = text(value);
  try {
    new URL(result);
  } catch {
    throw contractError();
  }
  return result;
}

export function parseSignedImportParts(value: unknown): SignedImportPart[] {
  const item = record(value, ["parts"]);
  if (!Array.isArray(item.parts)) throw contractError();
  return item.parts.map((raw) => {
    const part = record(raw, ["partNumber", "url", "headers", "expiresAt"]);
    return {
      partNumber: integer(part.partNumber, 1, 10_000),
      url: absoluteUrl(part.url),
      headers: stringRecord(part.headers),
      expiresAt: timestamp(part.expiresAt),
    };
  });
}

export function isTerminalImportState(state: ImportState): boolean {
  return state === "READY" || state === "FAILED";
}

export function isActiveImportState(state: ImportState): boolean {
  return !isTerminalImportState(state);
}

export function localIsoDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatCivilDate(value: string): string {
  const parts = civilDateParts(value);
  if (!parts) throw new Error("Data civil inválida.");
  const [year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

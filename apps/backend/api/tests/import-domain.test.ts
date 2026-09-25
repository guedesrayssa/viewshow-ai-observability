import { importSafeErrorSchema, type ImportState } from "@view-show/contracts";
import { describe, expect, it } from "vitest";
import type { ImportRecord } from "../src/modules/imports/domain/import.ts";
import {
  assertImportTransition,
  createImportId,
  decodeImportPipelineVersion,
  isActiveImportState,
  toPublicImport,
} from "../src/modules/imports/domain/import.ts";

const record: ImportRecord = {
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Ana", email: "ana@example.test" },
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:01:00.000Z",
  state: "UPLOADING",
  version: 4,
  progress: { kind: "bytes", completedBytes: 512, totalBytes: 1024 },
  candidateVersion: null,
  error: null,
  bucket: "private-imports",
  key: "imports/imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3/dump.sql.gz",
  uploadId: "s3-multipart-id",
  taskArn: "arn:aws:states:sa-east-1:123456789012:execution:imports:abc",
  physicalVersion: "dynamo-version-19",
  pipelineVersion: "canonical-v2",
};

const allowedTransitions: readonly (readonly [ImportState, ImportState])[] = [
  ["PREPARING", "UPLOADING"],
  ["PREPARING", "FAILED"],
  ["UPLOADING", "UPLOADED"],
  ["UPLOADING", "FAILED"],
  ["UPLOADED", "VALIDATING"],
  ["UPLOADED", "FAILED"],
  ["VALIDATING", "PROCESSING"],
  ["VALIDATING", "FAILED"],
  ["PROCESSING", "READY"],
  ["PROCESSING", "FAILED"],
];

const importStates: readonly ImportState[] = [
  "PREPARING",
  "UPLOADING",
  "UPLOADED",
  "VALIDATING",
  "PROCESSING",
  "READY",
  "FAILED",
];

const transitionCases = importStates.flatMap((from) =>
  importStates.map((to) => ({
    from,
    to,
    allowed: allowedTransitions.some(
      ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
    ),
  })),
);

const permittedTransitionCases = transitionCases.filter(
  ({ allowed }) => allowed,
);
const prohibitedTransitionCases = transitionCases.filter(
  ({ allowed }) => !allowed,
);

describe("import domain", () => {
  it("decodes an import without a stored pipeline version as legacy-v1", () => {
    expect(decodeImportPipelineVersion(undefined)).toBe("legacy-v1");
  });

  it("requires a bounded correlation identity and preserves it in public failures", () => {
    const error = {
      code: "INTERNAL_ERROR" as const,
      message: "Não foi possível concluir a importação.",
      requestId: "req_import_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
      stage: null,
      retryable: false,
      attempt: 1,
      maxAttempts: null,
    };
    expect(importSafeErrorSchema.safeParse(error).success).toBe(true);
    expect(
      importSafeErrorSchema.safeParse({
        code: error.code,
        message: error.message,
      }).success,
    ).toBe(false);
    expect(
      importSafeErrorSchema.safeParse({
        ...error,
        requestId: "s3://private/key",
      }).success,
    ).toBe(false);
    expect(toPublicImport({ ...record, error }, "usr_owner").error).toEqual(
      error,
    );
  });

  it("normalizes legacy stored failures to exact additive defaults", () => {
    const legacy = {
      code: "INTERNAL_ERROR" as const,
      message: "Não foi possível concluir a importação.",
      requestId: "req_import_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
    };

    expect(
      toPublicImport({ ...record, error: legacy } as ImportRecord, "usr_owner")
        .error,
    ).toEqual({
      ...legacy,
      stage: null,
      retryable: false,
      attempt: 1,
      maxAttempts: null,
    });
  });

  it.each([
    [
      "MYSQL_CONNECTION_LOST" as const,
      "A conexão com o MySQL foi perdida após as tentativas de reconexão.",
    ],
    [
      "ARCHIVE_PUBLICATION_FAILED" as const,
      "Não foi possível publicar o arquivo canônico. Tente novamente.",
    ],
    [
      "DYNAMODB_THROTTLED" as const,
      "O armazenamento de controle está temporariamente sobrecarregado. Tente novamente.",
    ],
    [
      "DISK_PRESSURE" as const,
      "Não há espaço temporário suficiente para concluir a importação.",
    ],
    [
      "CHECKSUM_MISMATCH" as const,
      "A integridade dos dados da importação não pôde ser confirmada.",
    ],
    [
      "SOURCE_SCHEMA_INVALID" as const,
      "O esquema ou a cobertura da origem é incompatível.",
    ],
    [
      "DATA_RECONCILIATION_FAILED" as const,
      "As evidências publicadas não reconciliam com os dados importados.",
    ],
    ["INTERNAL_ERROR" as const, "Não foi possível concluir a importação."],
  ])(
    "sanitizes untrusted stored text for %s at the public boundary",
    (code, message) => {
      const error = toPublicImport(
        {
          ...record,
          error: {
            code,
            message:
              "SELECT cursor FROM mysql.internal:3306 WHERE key = 's3://private/key'",
            requestId: "req_safe_boundary",
          },
        },
        "usr_owner",
      ).error;

      expect(error?.message).toBe(message);
      expect(JSON.stringify(error)).not.toMatch(
        /SELECT|cursor|mysql\.internal|s3:\/\//i,
      );
    },
  );
  it("creates lexicographically sortable, opaque import IDs", () => {
    const first = createImportId(
      new Date("2026-09-17T10:00:00.000Z"),
      Buffer.alloc(10, 1),
    );
    const second = createImportId(
      new Date("2026-09-17T10:00:00.001Z"),
      Buffer.alloc(10, 0),
    );

    expect(first).toMatch(/^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(first < second).toBe(true);
  });

  it("uses entropy to keep IDs in the same millisecond unique and ordered", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");
    const lowerEntropy = createImportId(now, Buffer.alloc(10, 0));
    const higherEntropy = createImportId(now, Buffer.alloc(10, 255));

    expect(lowerEntropy).not.toBe(higherEntropy);
    expect(lowerEntropy < higherEntropy).toBe(true);
  });

  it("rejects invalid ULID entropy lengths and timestamps outside 48 bits", () => {
    expect(() => createImportId(new Date(0), Buffer.alloc(9))).toThrow();
    expect(() => createImportId(new Date(0), Buffer.alloc(11))).toThrow();
    expect(() => createImportId(new Date(-1), Buffer.alloc(10))).toThrow();
    expect(() => createImportId(new Date(2 ** 48), Buffer.alloc(10))).toThrow();
  });

  it("derives the exact 10 allowed and 39 prohibited transition combinations", () => {
    expect(transitionCases).toHaveLength(49);
    expect(permittedTransitionCases).toHaveLength(10);
    expect(prohibitedTransitionCases).toHaveLength(39);
  });

  it.each(permittedTransitionCases)(
    "allows the prescribed transition $from -> $to",
    ({ from, to }) => {
      expect(() => assertImportTransition(from, to)).not.toThrow();
    },
  );

  it.each(prohibitedTransitionCases)(
    "rejects the prohibited transition $from -> $to",
    ({ from, to }) => {
      expect(() => assertImportTransition(from, to)).toThrow();
    },
  );

  it("recognizes only unfinished imports as active", () => {
    expect(isActiveImportState("PREPARING")).toBe(true);
    expect(isActiveImportState("PROCESSING")).toBe(true);
    expect(isActiveImportState("READY")).toBe(false);
    expect(isActiveImportState("FAILED")).toBe(false);
  });

  it("projects only public fields and derives upload management for its owner", () => {
    const snapshot = toPublicImport(record, "usr_owner");

    expect(snapshot).toEqual({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
      requestedBy: "usr_owner",
      author: { id: "usr_owner", name: "Ana", email: "ana@example.test" },
      canManageUpload: true,
      fileName: "argus_dump.sql.gz",
      sizeBytes: 1024,
      snapshotExtractedOn: "2026-09-17",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:01:00.000Z",
      state: "UPLOADING",
      version: 4,
      progress: { kind: "bytes", completedBytes: 512, totalBytes: 1024 },
      candidateVersion: null,
      error: null,
    });
    expect(snapshot).not.toHaveProperty("pipelineVersion");
  });

  it("does not grant upload management to other viewers or terminal imports", () => {
    expect(toPublicImport(record, "usr_reader").canManageUpload).toBe(false);
    expect(
      toPublicImport({ ...record, state: "READY" }, "usr_owner")
        .canManageUpload,
    ).toBe(false);
  });

  it("projects stage progress without losing durable counters", () => {
    expect(
      toPublicImport(
        {
          ...record,
          state: "PROCESSING",
          progress: {
            kind: "stage",
            stage: "PROJECTING",
            stageStartedAt: "2026-09-17T10:00:00.000Z",
            heartbeatAt: "2026-09-17T10:01:00.000Z",
            recordsRead: 13,
            recordsWritten: 11,
            recordsRejected: 2,
            recordsTotal: 20,
            currentDataset: null,
            datasetsCompleted: 23,
            datasetsTotal: 23,
          },
        },
        "usr_reader",
      ).progress,
    ).toEqual({
      kind: "stage",
      stage: "PROJECTING",
      stageStartedAt: "2026-09-17T10:00:00.000Z",
      heartbeatAt: "2026-09-17T10:01:00.000Z",
      recordsRead: 13,
      recordsWritten: 11,
      recordsRejected: 2,
      recordsTotal: 20,
      currentDataset: null,
      datasetsCompleted: 23,
      datasetsTotal: 23,
    });
  });

  it("projects an explicit none progress variant", () => {
    expect(
      toPublicImport(
        { ...record, state: "PREPARING", progress: { kind: "none" } },
        "usr_reader",
      ).progress,
    ).toEqual({ kind: "none" });
  });
});

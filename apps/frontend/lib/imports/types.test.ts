import { describe, expect, it } from "vitest";

import civilDateCases from "../../../backend/api/contracts/fixtures/civil-date-cases.json";

import {
  formatCivilDate,
  localIsoDate,
  parseImportParts,
  parseImportSnapshot,
  parseSignedImportParts,
} from "@/lib/imports/types";

const validSnapshot = {
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Maria", email: "maria@example.com" },
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:01.000-03:00",
  state: "UPLOADING",
  version: 2,
  progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
  candidateVersion: null,
  error: null,
};

describe("datas civis da importação", () => {
  it("usa componentes locais em vez do dia UTC", () => {
    const localLateNight = new Date(2026, 8, 17, 23, 30, 0);
    expect(localIsoDate(localLateNight)).toBe("2026-09-17");
  });

  it("formata YYYY-MM-DD sem converter para instante", () => {
    expect(formatCivilDate("2026-09-17")).toBe("17/09/2026");
    expect(() => formatCivilDate("2026-13-40")).toThrow(/data/i);
  });

  it("mantém parser e formatter em paridade com o contrato de data civil", () => {
    for (const value of civilDateCases.valid) {
      expect(
        parseImportSnapshot({ ...validSnapshot, snapshotExtractedOn: value })
          .snapshotExtractedOn,
        value,
      ).toBe(value);
      const [year, month, day] = value.split("-");
      expect(formatCivilDate(value), value).toBe(`${day}/${month}/${year}`);
    }

    for (const value of civilDateCases.invalid) {
      expect(
        () =>
          parseImportSnapshot({
            ...validSnapshot,
            snapshotExtractedOn: value,
          }),
        value,
      ).toThrow("A API devolveu dados de importação fora do contrato.");
      expect(() => formatCivilDate(value), value).toThrow(
        /data civil inválida/i,
      );
    }
  });
});

describe("parsers do contrato público de importação", () => {
  it("normaliza erro legado e preserva a causa pública acionável", () => {
    expect(
      parseImportSnapshot({
        ...validSnapshot,
        state: "FAILED",
        error: {
          code: "INTERNAL_ERROR",
          message: "Não foi possível concluir a importação.",
          requestId: "req_legacy",
        },
      }).error,
    ).toEqual({
      code: "INTERNAL_ERROR",
      message: "Não foi possível concluir a importação.",
      requestId: "req_legacy",
      stage: null,
      retryable: false,
      attempt: 1,
      maxAttempts: null,
    });

    const actionable = {
      code: "MYSQL_QUERY_TIMEOUT",
      message: "A consulta ao MySQL excedeu o tempo limite.",
      requestId: "req_timeout",
      stage: "INGESTING",
      retryable: true,
      attempt: 4,
      maxAttempts: 4,
    };
    expect(
      parseImportSnapshot({
        ...validSnapshot,
        state: "FAILED",
        error: actionable,
      }).error,
    ).toEqual(actionable);

    for (const code of [
      "ARCHIVE_PUBLICATION_FAILED",
      "DYNAMODB_THROTTLED",
      "DISK_PRESSURE",
      "CHECKSUM_MISMATCH",
      "SOURCE_SCHEMA_INVALID",
      "DATA_RECONCILIATION_FAILED",
    ]) {
      expect(
        parseImportSnapshot({
          ...validSnapshot,
          state: "FAILED",
          error: { ...actionable, code },
        }).error?.code,
      ).toBe(code);
    }
  });

  it("preserva o detalhamento de atividade de uma etapa longa", () => {
    const progress = {
      kind: "stage",
      stage: "INGESTING",
      stageStartedAt: "2026-09-17T10:00:00.000Z",
      heartbeatAt: "2026-09-17T10:01:00.000Z",
      recordsRead: 125,
      recordsWritten: 120,
      recordsRejected: 5,
      recordsTotal: 1000,
      currentDataset: "signal_bucket",
      datasetsCompleted: 2,
      datasetsTotal: 23,
    };

    expect(
      parseImportSnapshot({
        ...validSnapshot,
        state: "PROCESSING",
        progress,
      }).progress,
    ).toEqual(progress);
  });

  it("aceita stages canônicos e unidades opcionais somente como grupo completo", () => {
    const progress = {
      kind: "stage",
      stage: "ARCHIVING",
      recordsRead: 10,
      recordsWritten: 10,
      recordsRejected: 0,
      substage: "UPLOADING",
      currentPartition: "snapshot_date=2026-09-17",
      unitsCompleted: 2,
      unitsTotal: 3,
      unitLabel: "partições",
    };

    expect(
      parseImportSnapshot({
        ...validSnapshot,
        state: "PROCESSING",
        progress,
      }).progress,
    ).toEqual(progress);
    expect(() =>
      parseImportSnapshot({
        ...validSnapshot,
        state: "PROCESSING",
        progress: { ...progress, unitsTotal: 1 },
      }),
    ).toThrow(/contrato/i);
    expect(() =>
      parseImportSnapshot({
        ...validSnapshot,
        state: "PROCESSING",
        progress: { ...progress, unitLabel: undefined },
      }),
    ).toThrow(/contrato/i);
  });

  it("rejeita stage desconhecido", () => {
    expect(() =>
      parseImportSnapshot({
        ...validSnapshot,
        state: "PROCESSING",
        progress: {
          kind: "stage",
          stage: "FUTURE_STAGE",
          recordsRead: 0,
          recordsWritten: 0,
          recordsRejected: 0,
        },
      }),
    ).toThrow(/contrato/i);
  });

  it("rejeita filename, timestamp e dataset version fora do Zod público", () => {
    expect(() =>
      parseImportSnapshot({ ...validSnapshot, fileName: "dump.sql" }),
    ).toThrow(/contrato/i);
    expect(() =>
      parseImportSnapshot({
        ...validSnapshot,
        createdAt: "2026-09-17T10:00:00Z",
      }),
    ).toThrow(/contrato/i);
    expect(() =>
      parseImportSnapshot({ ...validSnapshot, candidateVersion: "latest" }),
    ).toThrow(/contrato/i);
  });

  it("rejeita limites de parte e URL assinada inválida", () => {
    expect(() =>
      parseImportParts({
        parts: [
          {
            partNumber: 10_001,
            etag: "etag",
            checksumSha256: "A".repeat(43) + "=",
            sizeBytes: 1,
          },
        ],
      }),
    ).toThrow(/contrato/i);
    expect(() =>
      parseSignedImportParts({
        parts: [
          {
            partNumber: 1,
            url: "não é URL",
            headers: {},
            expiresAt: "2026-09-17T10:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/contrato/i);
  });
});

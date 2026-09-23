import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatCivilDate,
  importAuthorLabel,
  importFailureMessage,
  importStageLabel,
  importStatePresentation,
  localIsoDate,
} from "@/components/imports/import-presentation";
import type { ImportSnapshot, ImportState } from "@/lib/imports/types";

const snapshot = (author: ImportSnapshot["author"]): ImportSnapshot => ({
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_fallback",
  author,
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:00.000Z",
  state: "UPLOADING",
  version: 1,
  progress: { kind: "bytes", completedBytes: 0, totalBytes: 1 },
  candidateVersion: null,
  error: null,
});

describe("apresentação de importações", () => {
  it("usa a data civil local, sem conversão UTC", () => {
    expect(localIsoDate(new Date(2026, 8, 17, 23, 30))).toBe("2026-09-17");
    expect(formatCivilDate("2026-09-17")).toBe("17/09/2026");
  });

  it("formata bytes em base binária", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(16 * 1024 ** 2)).toBe("16 MiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GiB");
  });

  it("escolhe nome, depois e-mail e depois identificador do autor", () => {
    expect(
      importAuthorLabel(
        snapshot({ id: "u", name: "Maria", email: "m@x.test" }),
      ),
    ).toBe("Maria");
    expect(
      importAuthorLabel(snapshot({ id: "u", name: null, email: "m@x.test" })),
    ).toBe("m@x.test");
    expect(
      importAuthorLabel(snapshot({ id: "u", name: null, email: null })),
    ).toBe("usr_fallback");
  });

  it("mapeia todos os estados e stages conhecidos com fallback seguro", () => {
    const states: ImportState[] = [
      "PREPARING",
      "UPLOADING",
      "UPLOADED",
      "VALIDATING",
      "PROCESSING",
      "READY",
      "FAILED",
    ];
    expect(states.map((state) => importStatePresentation(state).label)).toEqual(
      [
        "Preparando upload",
        "Enviando arquivo",
        "Upload concluído",
        "Validando dump",
        "Processando dados",
        "Pronto",
        "Falhou",
      ],
    );
    expect(importStageLabel("INGESTING")).toBe("Ingerindo registros");
    expect(importStageLabel("EXTRACTING")).toBe("Extraindo registros");
    expect(importStageLabel("ARCHIVING")).toBe("Publicando arquivos canônicos");
    expect(importStageLabel("MATERIALIZING_HOT")).toBe(
      "Preparando dados de consulta",
    );
    expect(importStageLabel("MATERIALIZING_HOT", "SKIPPED_BY_POLICY")).toBe(
      "Ignorado por política",
    );
    expect(importStageLabel("FINALIZING_CANDIDATE")).toBe(
      "Finalizando candidato",
    );
    expect(importStageLabel("CUSTOM_STAGE")).toBe("CUSTOM STAGE");
  });

  it.each([
    ["MYSQL_CONNECTION_LOST", /reconexão/i],
    ["MYSQL_QUERY_TIMEOUT", /tempo limite/i],
    ["QUERY_PLAN_INVALID", /plano de consulta/i],
    ["ARCHIVE_PUBLICATION_FAILED", /arquivo canônico/i],
    ["DYNAMODB_THROTTLED", /armazenamento de controle/i],
    ["DISK_PRESSURE", /espaço temporário/i],
    ["CHECKSUM_MISMATCH", /integridade dos dados/i],
    ["SOURCE_SCHEMA_INVALID", /esquema ou a cobertura/i],
    ["DATA_RECONCILIATION_FAILED", /evidências publicadas/i],
    ["INTERNAL_ERROR", /não foi possível concluir a importação/i],
  ])("explica a recuperação de %s sem detalhes internos", (code, expected) => {
    const message = importFailureMessage(code);
    expect(message).toMatch(expected);
    expect(message).not.toMatch(/SELECT|cursor|private/i);
  });
});

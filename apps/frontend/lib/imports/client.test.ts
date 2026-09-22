import { describe, expect, it, vi } from "vitest";

import { ENDPOINTS } from "@/lib/data/endpoints";
import { ImportClient } from "@/lib/imports/client";
import type { ImportSnapshot } from "@/lib/imports/types";

const snapshot: ImportSnapshot = {
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Maria", email: "maria@example.com" },
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:00.000Z",
  state: "UPLOADING",
  version: 2,
  progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
  candidateVersion: null,
  error: null,
};

const meta = {
  requestId: "req_test",
  schemaVersion: "1.0",
  datasetVersion: null,
  generatedAt: "2026-09-17T10:00:00.000Z",
  window: null,
  partial: false,
  refreshAfterSeconds: null,
  freshness: [],
  warnings: [],
};

describe("ImportClient", () => {
  it("implementa as oito rotas e envia idempotência nas mutações duráveis", async () => {
    const requester = vi.fn(async (path: string) => {
      if (path.endsWith("/activate"))
        return {
          data: {
            importId: snapshot.importId,
            datasetVersion: `dsv_${"a".repeat(64)}`,
            activatedAt: "2026-09-17T10:04:00.000Z",
            activatedBy: "usr_reader",
            changed: true,
          },
          meta,
        };
      if (path.endsWith("/parts"))
        return path.includes("sign")
          ? { data: { parts: [] }, meta }
          : { data: { parts: [] }, meta };
      if (path === ENDPOINTS.imports.root && requester.mock.calls.length === 1)
        return { data: { items: [snapshot], cursor: "next cursor" }, meta };
      return { data: snapshot, meta };
    });
    const client = new ImportClient(requester);
    const importId = "imp/id with spaces";

    await expect(
      client.list({ limit: 25, cursor: "next cursor" }),
    ).resolves.toEqual({
      items: [snapshot],
      cursor: "next cursor",
    });
    await client.get(importId);
    await client.start(
      {
        fileName: "argus_dump.sql.gz",
        sizeBytes: 1024,
        snapshotExtractedOn: "2026-09-17",
      },
      { idempotencyKey: "start-key" },
    );
    await client.listParts(importId);
    await client.signParts(importId, [
      { partNumber: 1, checksumSha256: "A".repeat(43) + "=" },
    ]);
    await client.restart(importId, { idempotencyKey: "restart-key" });
    await client.complete(
      importId,
      [
        {
          partNumber: 1,
          etag: '"etag"',
          checksumSha256: "A".repeat(43) + "=",
        },
      ],
      { idempotencyKey: "complete-key" },
    );
    await (
      client as unknown as {
        activate(
          importId: string,
          control: { idempotencyKey: string },
        ): Promise<unknown>;
      }
    ).activate(importId, { idempotencyKey: "activate-key" });

    expect(requester.mock.calls).toEqual([
      [
        ENDPOINTS.imports.root,
        { method: "GET", params: { limit: 25, cursor: "next cursor" } },
      ],
      [ENDPOINTS.imports.status(importId), { method: "GET" }],
      [
        ENDPOINTS.imports.root,
        {
          method: "POST",
          json: {
            fileName: "argus_dump.sql.gz",
            sizeBytes: 1024,
            snapshotExtractedOn: "2026-09-17",
          },
          idempotencyKey: "start-key",
        },
      ],
      [ENDPOINTS.imports.parts(importId), { method: "GET" }],
      [
        ENDPOINTS.imports.parts(importId),
        {
          method: "POST",
          json: {
            parts: [{ partNumber: 1, checksumSha256: "A".repeat(43) + "=" }],
          },
        },
      ],
      [
        ENDPOINTS.imports.restart(importId),
        {
          method: "POST",
          json: {},
          idempotencyKey: "restart-key",
        },
      ],
      [
        ENDPOINTS.imports.complete(importId),
        {
          method: "POST",
          json: {
            parts: [
              {
                partNumber: 1,
                etag: '"etag"',
                checksumSha256: "A".repeat(43) + "=",
              },
            ],
          },
          idempotencyKey: "complete-key",
        },
      ],
      [
        (ENDPOINTS.imports as unknown as { activate(id: string): string }).activate(
          importId,
        ),
        {
          method: "POST",
          json: {},
          idempotencyKey: "activate-key",
        },
      ],
    ]);
    expect(ENDPOINTS.imports.status(importId)).toContain(
      "imp%2Fid%20with%20spaces",
    );
  });

  it("gera chaves fortes distintas e limitadas ao contrato", async () => {
    const { createImportIdempotencyKey } = await import("@/lib/imports/client");
    const first = createImportIdempotencyKey("start");
    const second = createImportIdempotencyKey("start");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^import-start-/);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("converte data civil legada impossível do histórico em erro seguro", async () => {
    const requester = vi.fn(async () => ({
      data: {
        items: [{ ...snapshot, snapshotExtractedOn: "2026-02-30" }],
        cursor: null,
      },
      meta,
    }));
    const client = new ImportClient(requester);

    await expect(client.list()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: "A API devolveu dados de importação fora do contrato.",
    });
  });
});

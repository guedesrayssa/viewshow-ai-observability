import { describe, expect, it } from "vitest";
import { ImportUseCases } from "../src/modules/imports/application/import-use-cases.ts";
import type { ImportControlPort } from "../src/modules/imports/ports/import-control.ts";

describe("ImportUseCases", () => {
  it("delegates a validated start request and fails closed when imports are unavailable", async () => {
    const calls: unknown[] = [];
    const control: ImportControlPort = {
      async start(input) {
        calls.push(input);
        return "unavailable";
      },
      async complete() {
        return "unavailable";
      },
      async get() {
        return "unavailable";
      },
    };
    const useCases = new ImportUseCases(control);

    await expect(
      useCases.start({
        fileName: "argus.sql.gz",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        partCount: 1,
        requestedBy: "usr_e2e",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
      message: "A importação requer S3 e uma tarefa de ingestão configurados.",
    });
    expect(calls).toEqual([
      {
        fileName: "argus.sql.gz",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        partCount: 1,
        requestedBy: "usr_e2e",
      },
    ]);
  });

  it("delegates completion and retrieval only to return the unavailable contract", async () => {
    const calls: string[] = [];
    const control: ImportControlPort = {
      async start() {
        return "unavailable";
      },
      async complete(input) {
        calls.push(`complete:${input.importId}:${input.requestedBy}`);
        return "unavailable";
      },
      async get(importId, requestedBy) {
        calls.push(`get:${importId}:${requestedBy}`);
        return "unavailable";
      },
    };
    const useCases = new ImportUseCases(control);

    await expect(
      useCases.complete({
        importId: "imp_1",
        parts: [{ partNumber: 1, etag: "etag-1" }],
        requestedBy: "usr_e2e",
      }),
    ).rejects.toMatchObject({ status: 503, code: "FEATURE_UNAVAILABLE" });
    await expect(useCases.get("imp_1", "usr_e2e")).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
    });
    expect(calls).toEqual(["complete:imp_1:usr_e2e", "get:imp_1:usr_e2e"]);
  });
});

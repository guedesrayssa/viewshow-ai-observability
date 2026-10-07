import { describe, expect, it } from "vitest";
import { createImportsModule } from "../src/modules/imports/index.ts";
import { loadImportConfig } from "../src/config.ts";
import { importFixture, startInput } from "./support/import-fixture.ts";
import type { ImportWorkerLauncher } from "../src/modules/imports/ports/import-worker-launcher.ts";

const environment = {
  IMPORT_BUCKET: "private-imports",
  IMPORT_EXPECTED_BUCKET_OWNER: "123456789012",
  IMPORT_CURSOR_SECRET: "x".repeat(32),
  AWS_REGION: "us-east-1",
  OPERATIONAL_TABLE_NAME: "operational",
  IMPORT_KUBERNETES_NAMESPACE: "view-show-imports",
  IMPORT_KUBERNETES_TEMPLATE: "ingestion-import",
  IMPORT_INGESTION_CONTAINER_NAME: "ingestion",
};
describe("imports configuration", () => {
  it("validates bucket ownership and cursor credentials", () => {
    expect(loadImportConfig(environment)).toMatchObject({
      bucket: "private-imports",
      expectedBucketOwner: "123456789012",
      cursorSecret: "x".repeat(32),
      ingestion: {
        namespace: "view-show-imports",
        templateName: "ingestion-import",
        containerName: "ingestion",
      },
    });
    for (const changes of [
      { IMPORT_BUCKET: "" },
      { IMPORT_EXPECTED_BUCKET_OWNER: "bad" },
      { IMPORT_CURSOR_SECRET: "short" },
      { IMPORT_KUBERNETES_NAMESPACE: "" },
      { IMPORT_KUBERNETES_NAMESPACE: "../other" },
      { IMPORT_KUBERNETES_TEMPLATE: "" },
      { IMPORT_INGESTION_CONTAINER_NAME: "" },
    ]) {
      expect(() => loadImportConfig({ ...environment, ...changes })).toThrow();
    }
  });
  it("builds a functional module with injected ports", async () => {
    const f = importFixture();
    const module = createImportsModule(environment, {
      repository: f.repository,
      uploadStore: f.store,
      workerLauncher: {
        launch: async () => ({ taskArn: "task" }),
        status: async () => ({ state: "RUNNING" }),
      } satisfies ImportWorkerLauncher,
      reconcilerOwner: "test-process",
    });
    expect(await module.useCases.start(startInput)).toMatchObject({
      data: { state: "UPLOADING" },
    });
    expect(module.reconciler).toBeDefined();
  });
});

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
  IMPORT_INGESTION_CLUSTER_ARN:
    "arn:aws:ecs:us-east-1:123456789012:cluster/argus-ingestion",
  IMPORT_INGESTION_TASK_DEFINITION_ARN:
    "arn:aws:ecs:us-east-1:123456789012:task-definition/g05-ingestion-import:7",
  IMPORT_INGESTION_SUBNET_IDS: " subnet-private-a,subnet-private-b ",
  IMPORT_INGESTION_SECURITY_GROUP_ID: "sg-import",
  IMPORT_INGESTION_CONTAINER_NAME: "ingestion",
};
describe("imports configuration", () => {
  it("validates bucket ownership and cursor credentials", () => {
    expect(loadImportConfig(environment)).toMatchObject({
      bucket: "private-imports",
      expectedBucketOwner: "123456789012",
      cursorSecret: "x".repeat(32),
      ingestion: {
        clusterArn:
          "arn:aws:ecs:us-east-1:123456789012:cluster/argus-ingestion",
        taskDefinitionArn:
          "arn:aws:ecs:us-east-1:123456789012:task-definition/g05-ingestion-import:7",
        subnetIds: ["subnet-private-a", "subnet-private-b"],
        securityGroupId: "sg-import",
        containerName: "ingestion",
      },
    });
    for (const changes of [
      { IMPORT_BUCKET: "" },
      { IMPORT_EXPECTED_BUCKET_OWNER: "bad" },
      { IMPORT_CURSOR_SECRET: "short" },
      { IMPORT_INGESTION_CLUSTER_ARN: "" },
      { IMPORT_INGESTION_TASK_DEFINITION_ARN: "" },
      { IMPORT_INGESTION_SUBNET_IDS: "" },
      { IMPORT_INGESTION_SUBNET_IDS: "subnet-a,,subnet-b" },
      { IMPORT_INGESTION_SECURITY_GROUP_ID: "" },
      { IMPORT_INGESTION_CONTAINER_NAME: "" },
    ]) {
      expect(() => loadImportConfig({ ...environment, ...changes })).toThrow();
    }
  });
  it("accepts a stable task definition family ARN for staged rollouts", () => {
    const taskDefinitionArn =
      "arn:aws:ecs:us-east-1:123456789012:task-definition/g05-ingestion-import";

    expect(
      loadImportConfig({
        ...environment,
        IMPORT_INGESTION_TASK_DEFINITION_ARN: taskDefinitionArn,
      }).ingestion.taskDefinitionArn,
    ).toBe(taskDefinitionArn);
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

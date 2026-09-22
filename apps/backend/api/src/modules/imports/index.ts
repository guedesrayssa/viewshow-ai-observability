import { randomUUID } from "node:crypto";
import type { Logger } from "@view-show/contracts";
import { loadImportConfig } from "../../config.js";
import { DynamoImportRepository } from "./adapters/dynamodb-import-repository.js";
import { DynamoDatasetActivation } from "./adapters/dynamodb-dataset-activation.js";
import { EcsImportWorkerLauncher } from "./adapters/ecs-import-worker-launcher.js";
import { S3ImportUploadStore } from "./adapters/s3-import-upload-store.js";
import { ImportReconciler } from "./application/import-reconciler.js";
import type { ImportRepository } from "./ports/import-repository.js";
import type { ImportUploadStore } from "./ports/import-upload-store.js";
import type { ImportWorkerLauncher } from "./ports/import-worker-launcher.js";
import type { DatasetActivationPort } from "./ports/dataset-activation.js";
import { ImportUseCases } from "./application/import-use-cases.js";

export { ImportUseCases } from "./application/import-use-cases.js";
export type { ImportControlPort } from "./ports/import-control.js";

/** Builds the durable import control plane; ports can be replaced in tests. */
export function createImportsModule(
  environment: NodeJS.ProcessEnv,
  dependencies: {
    repository?: ImportRepository;
    uploadStore?: ImportUploadStore;
    workerLauncher?: ImportWorkerLauncher;
    activation?: DatasetActivationPort;
    reconcilerOwner?: string;
    logger?: Logger;
  } = {},
) {
  const config = loadImportConfig(environment);
  const repository =
    dependencies.repository ??
    new DynamoImportRepository(
      config.region,
      config.tableName,
      config.cursorSecret,
      undefined,
      config.endpoint,
    );
  const store =
    dependencies.uploadStore ??
    new S3ImportUploadStore(
      config.region,
      config.bucket,
      config.expectedBucketOwner,
    );
  const launcher =
    dependencies.workerLauncher ??
    new EcsImportWorkerLauncher(config.ingestion);
  const activation =
    dependencies.activation ??
    new DynamoDatasetActivation(
      config.region,
      config.tableName,
      undefined,
      config.endpoint,
    );
  return {
    useCases: new ImportUseCases(repository, store, {
      bucket: config.bucket,
      activation,
    }),
    reconciler: new ImportReconciler(repository, store, launcher, {
      owner: dependencies.reconcilerOwner ?? randomUUID(),
      canonicalFirstEnabled: config.canonicalFirstEnabled,
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    }),
  };
}

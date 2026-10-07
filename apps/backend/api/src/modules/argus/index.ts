import { DynamoArgusLiveSyncControl } from "./adapters/dynamodb-argus-live-sync-control.js";
import { KubernetesArgusScheduler } from "./adapters/kubernetes-argus-scheduler.js";
import { ArgusLiveSyncUseCases } from "./application/argus-live-sync-use-cases.js";
import { loadConfig } from "./config.js";

export { ArgusLiveSyncUseCases } from "./application/argus-live-sync-use-cases.js";

export function createArgusModule(
  environment: NodeJS.ProcessEnv = process.env,
): ArgusLiveSyncUseCases {
  const config = loadConfig(environment);
  return new ArgusLiveSyncUseCases(
    new DynamoArgusLiveSyncControl(
      config.region,
      config.tableName,
      undefined,
      config.endpoint,
    ),
    new KubernetesArgusScheduler(config.namespace, config.cronJobName),
  );
}

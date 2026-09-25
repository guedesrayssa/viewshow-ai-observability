import { DynamoActiveDatasetResolver } from "./adapters/dynamodb-active-dataset-resolver.js";
import { loadConfig } from "./config.js";
import type { ActiveDatasetResolver } from "./ports/active-dataset-resolver.js";

export type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "./ports/active-dataset-resolver.js";

export function createActiveDatasetModule(
  environment: NodeJS.ProcessEnv = process.env,
): ActiveDatasetResolver {
  const config = loadConfig(environment);
  return new DynamoActiveDatasetResolver(
    config.region,
    config.tableName,
    undefined,
    config.endpoint,
  );
}

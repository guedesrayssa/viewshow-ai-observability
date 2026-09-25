import { z } from "zod";

const requiredText = z.string().trim().min(1);

const schema = z
  .object({
    AWS_REGION: requiredText,
    OPERATIONAL_TABLE_NAME: requiredText,
    INGESTION_SCHEDULER_GROUP_NAME: requiredText,
    INGESTION_SCHEDULER_NAME: requiredText,
    DYNAMODB_ENDPOINT: z.url().optional(),
  })
  .passthrough();

export interface ArgusConfig {
  readonly region: string;
  readonly tableName: string;
  readonly schedulerGroupName: string;
  readonly schedulerName: string;
  readonly endpoint: string | undefined;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ArgusConfig {
  const value = schema.parse(environment);
  return {
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    schedulerGroupName: value.INGESTION_SCHEDULER_GROUP_NAME,
    schedulerName: value.INGESTION_SCHEDULER_NAME,
    endpoint: value.DYNAMODB_ENDPOINT,
  };
}

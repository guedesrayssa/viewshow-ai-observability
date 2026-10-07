import { z } from "zod";

const requiredText = z.string().trim().min(1);

const schema = z
  .object({
    AWS_REGION: requiredText,
    OPERATIONAL_TABLE_NAME: requiredText,
    KUBERNETES_NAMESPACE: requiredText,
    INGESTION_CRONJOB_NAME: requiredText,
    DYNAMODB_ENDPOINT: z.url().optional(),
  })
  .passthrough();

export interface ArgusConfig {
  readonly region: string;
  readonly tableName: string;
  readonly namespace: string;
  readonly cronJobName: string;
  readonly endpoint: string | undefined;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ArgusConfig {
  const value = schema.parse(environment);
  return {
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    namespace: value.KUBERNETES_NAMESPACE,
    cronJobName: value.INGESTION_CRONJOB_NAME,
    endpoint: value.DYNAMODB_ENDPOINT,
  };
}

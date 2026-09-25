import { z } from "zod";

const schema = z
  .object({
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z.string().min(1).default("view-show-operacional"),
    DYNAMODB_ENDPOINT: z.url().optional(),
  })
  .passthrough();

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  return {
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    endpoint: value.DYNAMODB_ENDPOINT,
  };
}

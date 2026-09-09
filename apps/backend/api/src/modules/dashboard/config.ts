import { z } from "zod";

const schema = z
  .object({
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z
      .string()
      .min(1)
      .default("monitoracao-operacional"),
    MONITORING_SOURCES: z.string().default("argus"),
  })
  .passthrough();

export interface DashboardQueryConfig {
  readonly region: string;
  readonly tableName: string;
  readonly monitoringSources: readonly string[];
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DashboardQueryConfig {
  const value = schema.parse(environment);
  return {
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    monitoringSources: value.MONITORING_SOURCES.split(",")
      .map((source) => source.trim())
      .filter(Boolean),
  };
}

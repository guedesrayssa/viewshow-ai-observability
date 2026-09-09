import { z } from "zod";

const schema = z
  .object({
    DASHBOARD_QUERY_HOST: z.string().default("127.0.0.1"),
    DASHBOARD_QUERY_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(3002),
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z
      .string()
      .min(1)
      .default("monitoracao-operacional"),
    MONITORING_SOURCES: z.string().default("argus"),
    INTERNAL_AUTH_TOKEN: z.string().min(24),
  })
  .passthrough();

export interface DashboardQueryConfig {
  readonly host: string;
  readonly port: number;
  readonly region: string;
  readonly tableName: string;
  readonly monitoringSources: readonly string[];
  readonly internalToken: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DashboardQueryConfig {
  const value = schema.parse(environment);
  return {
    host: value.DASHBOARD_QUERY_HOST,
    port: value.DASHBOARD_QUERY_PORT,
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    monitoringSources: value.MONITORING_SOURCES.split(",")
      .map((source) => source.trim())
      .filter(Boolean),
    internalToken: value.INTERNAL_AUTH_TOKEN,
  };
}

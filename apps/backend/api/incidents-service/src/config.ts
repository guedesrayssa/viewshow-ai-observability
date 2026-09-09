import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    INCIDENTS_HOST: z.string().default("127.0.0.1"),
    INCIDENTS_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z
      .string()
      .min(1)
      .default("monitoracao-operacional"),
    INTERNAL_AUTH_TOKEN: z.string().min(24),
    CURSOR_SECRET: z.string().min(32),
  })
  .passthrough();

export type IncidentsConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly region: string;
  readonly tableName: string;
  readonly internalToken: string;
  readonly cursorSecret: string;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IncidentsConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.INCIDENTS_HOST,
    port: value.INCIDENTS_PORT,
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    internalToken: value.INTERNAL_AUTH_TOKEN,
    cursorSecret: value.CURSOR_SECRET,
  };
}

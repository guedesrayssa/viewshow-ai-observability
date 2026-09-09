import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z
      .string()
      .min(1)
      .default("monitoracao-operacional"),
    CURSOR_SECRET: z.string().min(32),
  })
  .passthrough();

export type IncidentsConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly region: string;
  readonly tableName: string;
  readonly cursorSecret: string;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IncidentsConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    cursorSecret: value.CURSOR_SECRET,
  };
}

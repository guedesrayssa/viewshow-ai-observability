import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    AWS_REGION: z.string().default("us-east-1"),
    OPERATIONAL_TABLE_NAME: z.string().min(1).default("view-show-operacional"),
    DYNAMODB_ENDPOINT: z.url().optional(),
    CURSOR_SECRET: z.string().min(32),
    // Vazio significa "sem worker": o Terraform mantém a lista de ambiente
    // literal e envia "" quando não há consumidor da fila.
    ANALYSIS_QUEUE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
  })
  .passthrough();

export type IncidentsConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly region: string;
  readonly tableName: string;
  readonly endpoint: string | undefined;
  readonly cursorSecret: string;
  readonly analysisQueueUrl: string | undefined;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IncidentsConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    endpoint: value.DYNAMODB_ENDPOINT,
    cursorSecret: value.CURSOR_SECRET,
    analysisQueueUrl: value.ANALYSIS_QUEUE_URL,
  };
}

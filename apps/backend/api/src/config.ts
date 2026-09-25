import { z } from "zod";

const importSchema = z.object({
  AWS_REGION: z.string().min(1).default("us-east-1"),
  OPERATIONAL_TABLE_NAME: z
    .string()
    .trim()
    .min(1)
    .default("view-show-operacional"),
  DYNAMODB_ENDPOINT: z.url().optional(),
  IMPORT_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  IMPORT_EXPECTED_BUCKET_OWNER: z.string().regex(/^\d{12}$/),
  IMPORT_CURSOR_SECRET: z.string().min(32),
  IMPORT_INGESTION_CLUSTER_ARN: z
    .string()
    .trim()
    .regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:cluster\/[^/]+$/),
  IMPORT_INGESTION_TASK_DEFINITION_ARN: z
    .string()
    .trim()
    .regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:task-definition\/[^/:]+(?::\d+)?$/),
  IMPORT_INGESTION_SUBNET_IDS: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.split(",").every((part) => part.trim().length > 0))
    .transform((value) => [
      ...new Set(value.split(",").map((part) => part.trim())),
    ]),
  IMPORT_INGESTION_SECURITY_GROUP_ID: z.string().trim().min(1),
  IMPORT_INGESTION_CONTAINER_NAME: z.string().trim().min(1),
  IMPORT_CANONICAL_FIRST_ENABLED: z.enum(["true", "false"]).default("false"),
});

export function loadImportConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = importSchema.parse(environment);
  return {
    region: value.AWS_REGION,
    tableName: value.OPERATIONAL_TABLE_NAME,
    endpoint: value.DYNAMODB_ENDPOINT,
    bucket: value.IMPORT_BUCKET,
    expectedBucketOwner: value.IMPORT_EXPECTED_BUCKET_OWNER,
    cursorSecret: value.IMPORT_CURSOR_SECRET,
    canonicalFirstEnabled: value.IMPORT_CANONICAL_FIRST_ENABLED === "true",
    ingestion: {
      clusterArn: value.IMPORT_INGESTION_CLUSTER_ARN,
      taskDefinitionArn: value.IMPORT_INGESTION_TASK_DEFINITION_ARN,
      subnetIds: value.IMPORT_INGESTION_SUBNET_IDS,
      securityGroupId: value.IMPORT_INGESTION_SECURITY_GROUP_ID,
      containerName: value.IMPORT_INGESTION_CONTAINER_NAME,
    },
  };
}

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    FRONTEND_ORIGINS: z.string().default(""),
    FRONTEND_ORIGIN: z.string().default(""),
    METRICS_ENABLED: z.enum(["true", "false"]).default("true"),
    // 180 é o padrão de produção. Configurável para permitir uma janela de
    // teste de carga alta o bastante para medir RNF09/RNF14 na taxa alvo
    // sem editar código — ver apps/backend/api/loadtest/README.md.
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(180),
    // Limite dedicado para POST /auth/login, mais apertado que o geral: essa
    // rota é o alvo natural de força bruta/credential stuffing. O Cognito já
    // tem seu próprio throttling por usuário; este é por IP, na frente dele.
    AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  })
  .passthrough();

export interface ApiConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly frontendOrigins: readonly string[];
  readonly metricsEnabled: boolean;
  readonly rateLimitPerMinute: number;
  readonly authLoginRateLimitPerMinute: number;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    frontendOrigins: [
      ...new Set(
        [value.FRONTEND_ORIGIN, ...value.FRONTEND_ORIGINS.split(",")]
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    ],
    metricsEnabled: value.METRICS_ENABLED === "true",
    rateLimitPerMinute: value.RATE_LIMIT_PER_MINUTE,
    authLoginRateLimitPerMinute: value.AUTH_LOGIN_RATE_LIMIT_PER_MINUTE,
  };
}

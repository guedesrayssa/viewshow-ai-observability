import { z } from "zod";

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
  })
  .passthrough();

export interface ApiConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly frontendOrigins: readonly string[];
  readonly metricsEnabled: boolean;
  readonly rateLimitPerMinute: number;
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
  };
}

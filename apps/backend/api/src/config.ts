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
  })
  .passthrough();

export interface ApiConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly frontendOrigins: readonly string[];
  readonly metricsEnabled: boolean;
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
  };
}

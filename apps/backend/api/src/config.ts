import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    INCIDENTS_SERVICE_URL: z.url().default("http://127.0.0.1:3001"),
    DASHBOARD_QUERY_SERVICE_URL: z.url().default("http://127.0.0.1:3002"),
    IDENTITY_SERVICE_URL: z.url().default("http://127.0.0.1:3003"),
    INTERNAL_AUTH_TOKEN: z.string().min(24),
    INTERNAL_HTTP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(2500),
    FRONTEND_ORIGINS: z.string().default(""),
    FRONTEND_ORIGIN: z.string().default(""),
    METRICS_ENABLED: z.enum(["true", "false"]).default("true"),
  })
  .passthrough();

export interface GatewayConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly services: {
    readonly incidents: string;
    readonly dashboard: string;
    readonly identity: string;
  };
  readonly internalToken: string;
  readonly timeoutMs: number;
  readonly frontendOrigins: readonly string[];
  readonly metricsEnabled: boolean;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    services: {
      incidents: value.INCIDENTS_SERVICE_URL,
      dashboard: value.DASHBOARD_QUERY_SERVICE_URL,
      identity: value.IDENTITY_SERVICE_URL,
    },
    internalToken: value.INTERNAL_AUTH_TOKEN,
    timeoutMs: value.INTERNAL_HTTP_TIMEOUT_MS,
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

import { z } from "zod";

const optionalText = z.string().min(1).optional();
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    IDENTITY_HOST: z.string().default("127.0.0.1"),
    IDENTITY_PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
    INTERNAL_AUTH_TOKEN: z.string().min(24),
    AUTH_COOKIE_SECRET: z.string().min(32),
    IDENTITY_DEV_AUTH_ENABLED: z.enum(["true", "false"]).default("false"),
    IDENTITY_DEV_EMAIL: optionalText,
    IDENTITY_DEV_PASSWORD: optionalText,
    IDENTITY_DEV_NAME: optionalText,
    IDENTITY_DEV_ROLE: z
      .enum(["viewer", "engineer", "admin"])
      .default("engineer"),
    OIDC_ISSUER_URL: z.url().optional(),
    OIDC_CLIENT_ID: optionalText,
  })
  .passthrough();

export interface IdentityConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly internalToken: string;
  readonly cookieSecret: string;
  readonly devAuth:
    | false
    | {
        readonly email: string;
        readonly password: string;
        readonly name: string | null;
        readonly role: "viewer" | "engineer" | "admin";
      };
  readonly oidc: {
    readonly issuerUrl: string;
    readonly clientId: string;
  } | null;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const value = schema.parse(environment);
  if (
    value.NODE_ENV === "production" &&
    value.IDENTITY_DEV_AUTH_ENABLED === "true"
  ) {
    throw new Error("IDENTITY_DEV_AUTH_ENABLED is forbidden in production");
  }
  let devAuth: IdentityConfig["devAuth"] = false;
  if (value.IDENTITY_DEV_AUTH_ENABLED === "true") {
    if (!value.IDENTITY_DEV_EMAIL || !value.IDENTITY_DEV_PASSWORD)
      throw new Error(
        "Development identity credentials must be supplied through environment variables",
      );
    devAuth = {
      email: value.IDENTITY_DEV_EMAIL.trim().toLowerCase(),
      password: value.IDENTITY_DEV_PASSWORD,
      name: value.IDENTITY_DEV_NAME ?? null,
      role: value.IDENTITY_DEV_ROLE,
    };
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.IDENTITY_HOST,
    port: value.IDENTITY_PORT,
    internalToken: value.INTERNAL_AUTH_TOKEN,
    cookieSecret: value.AUTH_COOKIE_SECRET,
    devAuth,
    oidc:
      value.OIDC_ISSUER_URL && value.OIDC_CLIENT_ID
        ? { issuerUrl: value.OIDC_ISSUER_URL, clientId: value.OIDC_CLIENT_ID }
        : null,
  };
}

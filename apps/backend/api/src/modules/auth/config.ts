import { z } from "zod";

const optionalText = z.string().min(1).optional();
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    AUTH_COOKIE_SECRET: z.string().min(32),
    OIDC_ISSUER_URL: z.url().optional(),
    OIDC_CLIENT_ID: optionalText,
    AWS_REGION: optionalText,
    COGNITO_REGION: optionalText,
    COGNITO_USER_POOL_ID: optionalText,
    COGNITO_CLIENT_ID: optionalText,
    COGNITO_CLIENT_SECRET: optionalText,
  })
  .passthrough();

export interface IdentityConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly cookieSecret: string;
  readonly oidc: {
    readonly issuerUrl: string;
    readonly clientId: string;
  } | null;
  readonly cognito: {
    readonly region: string;
    readonly userPoolId: string;
    readonly clientId: string;
    readonly clientSecret: string | null;
  } | null;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const value = schema.parse(environment);
  const cognitoRegion = value.COGNITO_REGION ?? value.AWS_REGION ?? null;
  return {
    nodeEnv: value.NODE_ENV,
    cookieSecret: value.AUTH_COOKIE_SECRET,
    oidc:
      value.OIDC_ISSUER_URL && value.OIDC_CLIENT_ID
        ? { issuerUrl: value.OIDC_ISSUER_URL, clientId: value.OIDC_CLIENT_ID }
        : null,
    cognito:
      cognitoRegion && value.COGNITO_USER_POOL_ID && value.COGNITO_CLIENT_ID
        ? {
            region: cognitoRegion,
            userPoolId: value.COGNITO_USER_POOL_ID,
            clientId: value.COGNITO_CLIENT_ID,
            clientSecret: value.COGNITO_CLIENT_SECRET ?? null,
          }
        : null,
  };
}

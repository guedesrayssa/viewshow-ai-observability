import { initiateAuthViaSdk } from "./adapters/cognito-initiate-auth.js";
import { CognitoPasswordAuthenticator } from "./adapters/cognito-password-authenticator.js";
import { ConfiguredIdentityProvider } from "./adapters/configured-identity-provider.js";
import { UnavailablePasswordAuthenticator } from "./adapters/unavailable-password-authenticator.js";
import { IdentityUseCases } from "./application/identity-use-cases.js";
import { PasswordLoginUseCases } from "./application/password-login-use-cases.js";
import { loadConfig } from "./config.js";
import { SessionCodec } from "./domain/session.js";

export { IdentityUseCases } from "./application/identity-use-cases.js";
export { PasswordLoginUseCases } from "./application/password-login-use-cases.js";
export { SessionCodec, parseCookie } from "./domain/session.js";
export { passwordLoginBodySchema } from "./domain/password-login.js";
export type { PasswordLoginBody } from "./domain/password-login.js";

export interface AuthModule {
  readonly useCases: IdentityUseCases;
  readonly passwordLogin: PasswordLoginUseCases;
  readonly sessions: SessionCodec;
  readonly nodeEnv: "development" | "test" | "production";
}

/** Builds the auth module (federated identity boundary + signed sessions) for in-process use. */
export function createAuthModule(
  environment: NodeJS.ProcessEnv = process.env,
): AuthModule {
  const config = loadConfig(environment);
  const provider = new ConfiguredIdentityProvider();
  const passwordAuthenticator = config.cognito
    ? new CognitoPasswordAuthenticator(
        {
          region: config.cognito.region,
          clientId: config.cognito.clientId,
          clientSecret: config.cognito.clientSecret,
        },
        initiateAuthViaSdk,
      )
    : new UnavailablePasswordAuthenticator();
  return {
    useCases: new IdentityUseCases(provider),
    passwordLogin: new PasswordLoginUseCases(passwordAuthenticator),
    sessions: new SessionCodec(config.cookieSecret),
    nodeEnv: config.nodeEnv,
  };
}

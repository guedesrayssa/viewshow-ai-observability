import { ConfiguredIdentityProvider } from "./adapters/configured-identity-provider.js";
import { IdentityUseCases } from "./application/identity-use-cases.js";
import { loadConfig } from "./config.js";
import { SessionCodec } from "./domain/session.js";

export { IdentityUseCases } from "./application/identity-use-cases.js";
export { SessionCodec, parseCookie } from "./domain/session.js";

export interface AuthModule {
  readonly useCases: IdentityUseCases;
  readonly sessions: SessionCodec;
  readonly nodeEnv: "development" | "test" | "production";
}

/** Builds the auth module (federated identity boundary + signed sessions) for in-process use. */
export function createAuthModule(
  environment: NodeJS.ProcessEnv = process.env,
): AuthModule {
  const config = loadConfig(environment);
  const provider = new ConfiguredIdentityProvider();
  return {
    useCases: new IdentityUseCases(provider),
    sessions: new SessionCodec(config.cookieSecret),
    nodeEnv: config.nodeEnv,
  };
}

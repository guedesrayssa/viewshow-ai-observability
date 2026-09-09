import type { AuthenticatedIdentity } from "@view-show/contracts";

export interface IdentityProviderPort {
  authenticatePassword(
    email: string,
    password: string,
  ): Promise<AuthenticatedIdentity | null>;
  ssoEntryPoint(): Promise<string | null>;
}

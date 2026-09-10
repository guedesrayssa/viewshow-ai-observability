import type { AuthenticatedIdentity } from "@view-show/contracts";

export interface IdentityProviderPort {
  beginAuthorization(): Promise<string | null>;
  completeAuthorization(
    code: string,
    state: string,
  ): Promise<AuthenticatedIdentity | null>;
}

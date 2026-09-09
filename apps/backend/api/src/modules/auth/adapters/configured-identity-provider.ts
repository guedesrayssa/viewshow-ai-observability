import type { AuthenticatedIdentity } from "@view-show/contracts";
import type { IdentityProviderPort } from "../ports/identity-provider.js";

export class ConfiguredIdentityProvider implements IdentityProviderPort {
  async beginAuthorization(): Promise<string | null> {
    return null;
  }

  async completeAuthorization(
    _code: string,
    _state: string,
  ): Promise<AuthenticatedIdentity | null> {
    return null;
  }
}

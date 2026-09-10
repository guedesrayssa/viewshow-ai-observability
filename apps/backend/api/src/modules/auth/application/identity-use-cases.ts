import { ServiceError, type AuthenticatedIdentity } from "@view-show/contracts";
import type { IdentityProviderPort } from "../ports/identity-provider.js";

export class IdentityUseCases {
  constructor(private readonly provider: IdentityProviderPort) {}

  async beginLogin(): Promise<string> {
    const authorizationUrl = await this.provider.beginAuthorization();
    if (!authorizationUrl) this.providerUnavailable();
    return authorizationUrl;
  }

  async completeLogin(
    code: string,
    state: string,
  ): Promise<AuthenticatedIdentity> {
    const identity = await this.provider.completeAuthorization(code, state);
    if (!identity) this.providerUnavailable();
    return identity;
  }

  private providerUnavailable(): never {
    throw new ServiceError(
      503,
      "FEATURE_UNAVAILABLE",
      "O provedor corporativo de identidade não está configurado.",
    );
  }
}

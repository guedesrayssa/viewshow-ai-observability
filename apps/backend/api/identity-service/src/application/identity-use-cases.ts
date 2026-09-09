import { ServiceError, type AuthenticatedIdentity } from "@view-show/contracts";
import type { IdentityProviderPort } from "../ports/identity-provider.js";

export class IdentityUseCases {
  constructor(
    private readonly provider: IdentityProviderPort,
    private readonly passwordLoginAvailable: boolean,
  ) {}

  async login(email: string, password: string): Promise<AuthenticatedIdentity> {
    if (!this.passwordLoginAvailable)
      throw new ServiceError(
        503,
        "FEATURE_UNAVAILABLE",
        "O provedor corporativo de identidade não está configurado.",
      );
    const identity = await this.provider.authenticatePassword(email, password);
    if (!identity)
      throw new ServiceError(401, "UNAUTHENTICATED", "Credenciais inválidas.");
    return identity;
  }

  unavailable(feature: string): never {
    throw new ServiceError(
      503,
      "FEATURE_UNAVAILABLE",
      `${feature} requer um provedor corporativo configurado.`,
    );
  }
}

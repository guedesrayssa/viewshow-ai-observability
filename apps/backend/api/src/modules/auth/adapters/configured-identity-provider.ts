import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthenticatedIdentity } from "@view-show/contracts";
import type { IdentityConfig } from "../config.js";
import type { IdentityProviderPort } from "../ports/identity-provider.js";

const equal = (left: string, right: string): boolean => {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
};

export class ConfiguredIdentityProvider implements IdentityProviderPort {
  constructor(private readonly config: IdentityConfig) {}

  async authenticatePassword(
    email: string,
    password: string,
  ): Promise<AuthenticatedIdentity | null> {
    if (!this.config.devAuth) return null;
    const normalized = email.trim().toLowerCase();
    if (
      !equal(normalized, this.config.devAuth.email) ||
      !equal(password, this.config.devAuth.password)
    )
      return null;
    return {
      id: `dev_${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`,
      email: normalized,
      name: this.config.devAuth.name,
      role: this.config.devAuth.role,
    };
  }

  async ssoEntryPoint(): Promise<string | null> {
    return null;
  }
}

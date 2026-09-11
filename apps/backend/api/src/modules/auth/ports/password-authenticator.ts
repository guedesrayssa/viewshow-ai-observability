import type { AuthenticatedIdentity } from "@view-show/contracts";

/** Tokens emitidos pelo provedor após uma autenticação bem-sucedida. */
export interface IssuedTokens {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
  readonly tokenType: string;
}

/** Motivos de falha que o provedor sabe distinguir; o use case os traduz em HTTP. */
export type PasswordAuthFailureReason =
  | "invalid_credentials"
  | "user_not_confirmed"
  | "password_reset_required"
  | "challenge_required"
  | "rate_limited"
  | "unavailable";

export type PasswordAuthOutcome =
  | {
      readonly ok: true;
      readonly identity: AuthenticatedIdentity;
      readonly tokens: IssuedTokens;
    }
  | { readonly ok: false; readonly reason: PasswordAuthFailureReason };

export interface PasswordAuthenticatorPort {
  authenticate(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<PasswordAuthOutcome>;
}

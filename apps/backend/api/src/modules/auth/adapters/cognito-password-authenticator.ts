import { createHmac } from "node:crypto";
import type { AuthenticatedIdentity } from "@view-show/contracts";
import type {
  IssuedTokens,
  PasswordAuthFailureReason,
  PasswordAuthOutcome,
  PasswordAuthenticatorPort,
} from "../ports/password-authenticator.js";

export interface CognitoAuthenticatorConfig {
  readonly region: string;
  readonly clientId: string;
  /** Presente quando o app client foi criado com `generate_secret = true`. */
  readonly clientSecret: string | null;
}

/** Resultado bruto de um `InitiateAuth`, reduzido ao que este adaptador usa. */
export interface InitiateAuthResult {
  readonly authenticationResult:
    | {
        readonly idToken?: string | undefined;
        readonly accessToken?: string | undefined;
        readonly refreshToken?: string | undefined;
        readonly expiresIn?: number | undefined;
        readonly tokenType?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * Executa um `InitiateAuth` com fluxo `USER_PASSWORD_AUTH`. É o ponto de
 * costura: a implementação de produção (cognito-initiate-auth.ts) fala com a
 * AWS; os testes injetam um substituto e nunca carregam o SDK.
 */
export type InitiateAuthFn = (params: {
  readonly region: string;
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
  readonly secretHash: string | null;
}) => Promise<InitiateAuthResult>;

export class CognitoPasswordAuthenticator implements PasswordAuthenticatorPort {
  constructor(
    private readonly config: CognitoAuthenticatorConfig,
    private readonly initiateAuth: InitiateAuthFn,
  ) {}

  async authenticate(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<PasswordAuthOutcome> {
    let result: InitiateAuthResult;
    try {
      result = await this.initiateAuth({
        region: this.config.region,
        clientId: this.config.clientId,
        username: input.username,
        password: input.password,
        secretHash: this.config.clientSecret
          ? this.secretHash(input.username)
          : null,
      });
    } catch (error) {
      return { ok: false, reason: mapCognitoError(error) };
    }

    // Sem AuthenticationResult há um desafio pendente (NEW_PASSWORD_REQUIRED,
    // MFA, etc.) que este fluxo direto não conduz.
    const authentication = result.authenticationResult;
    if (!authentication?.idToken || !authentication.accessToken) {
      return { ok: false, reason: "challenge_required" };
    }

    const identity = identityFromIdToken(authentication.idToken);
    if (!identity) return { ok: false, reason: "unavailable" };

    const tokens: IssuedTokens = {
      idToken: authentication.idToken,
      accessToken: authentication.accessToken,
      refreshToken: authentication.refreshToken ?? null,
      expiresInSeconds: authentication.expiresIn ?? 0,
      tokenType: authentication.tokenType ?? "Bearer",
    };
    return { ok: true, identity, tokens };
  }

  // Exigido pelo Cognito quando o app client tem secret: HMAC-SHA256 de
  // (username + clientId) com o secret como chave, em base64.
  private secretHash(username: string): string {
    return createHmac("sha256", this.config.clientSecret as string)
      .update(username + this.config.clientId)
      .digest("base64");
  }
}

function mapCognitoError(error: unknown): PasswordAuthFailureReason {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { readonly name: unknown }).name)
      : "";
  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      // prevent_user_existence_errors=ENABLED já unifica os dois no Cognito;
      // tratamos igual aqui de qualquer forma para não vazar qual falhou.
      return "invalid_credentials";
    case "UserNotConfirmedException":
      return "user_not_confirmed";
    case "PasswordResetRequiredException":
      return "password_reset_required";
    case "TooManyRequestsException":
    case "LimitExceededException":
      return "rate_limited";
    default:
      return "unavailable";
  }
}

function identityFromIdToken(idToken: string): AuthenticatedIdentity | null {
  const segments = idToken.split(".");
  const payloadSegment = segments.length === 3 ? segments[1] : undefined;
  if (!payloadSegment) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object") return null;

  const id = typeof claims.sub === "string" ? claims.sub : null;
  if (!id) return null;

  const email =
    typeof claims.email === "string"
      ? claims.email
      : typeof claims["cognito:username"] === "string"
        ? (claims["cognito:username"] as string)
        : null;
  if (!email) return null;

  return {
    id,
    email,
    name: typeof claims.name === "string" ? claims.name : null,
    role: roleFromGroups(claims["cognito:groups"]),
  };
}

function roleFromGroups(groups: unknown): AuthenticatedIdentity["role"] {
  const names = Array.isArray(groups)
    ? groups.filter((group): group is string => typeof group === "string")
    : [];
  if (names.includes("admin")) return "admin";
  if (names.includes("engineer")) return "engineer";
  return "viewer";
}

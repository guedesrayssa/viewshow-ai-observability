import {
  ServiceError,
  createLogger,
  type AuthenticatedIdentity,
  type Logger,
} from "@view-show/contracts";
import type {
  IssuedTokens,
  PasswordAuthenticatorPort,
} from "../ports/password-authenticator.js";

export interface PasswordLoginResult {
  readonly identity: AuthenticatedIdentity;
  readonly tokens: IssuedTokens;
}

/**
 * Login direto por usuário/senha. Delega ao provedor e traduz cada motivo de
 * falha num `ServiceError` com o status certo, em vez de repassar o erro cru.
 */
export class PasswordLoginUseCases {
  constructor(
    private readonly authenticator: PasswordAuthenticatorPort,
    private readonly logger: Logger = createLogger("view-show-api"),
  ) {}

  async login(
    username: string,
    password: string,
  ): Promise<PasswordLoginResult> {
    const outcome = await this.authenticator.authenticate({
      username,
      password,
    });
    if (outcome.ok) {
      // user_id é o sub do Cognito (opaco). Nem e-mail nem senha entram no log.
      this.logger.info("password login succeeded", {
        event: "auth.login.succeeded",
        user_id: outcome.identity.id,
      });
      return { identity: outcome.identity, tokens: outcome.tokens };
    }
    // Insumo do alerta de força bruta (RNF04): uma linha por recusa, com o
    // motivo e sem o usuário digitado.
    this.logger.warn("password login rejected", {
      event: "auth.login.failed",
      reason: outcome.reason,
    });

    switch (outcome.reason) {
      case "invalid_credentials":
        throw new ServiceError(
          401,
          "UNAUTHENTICATED",
          "Usuário ou senha inválidos.",
        );
      case "user_not_confirmed":
        throw new ServiceError(
          403,
          "FORBIDDEN",
          "Usuário ainda não confirmado. Verifique o e-mail de confirmação.",
        );
      case "password_reset_required":
        throw new ServiceError(
          403,
          "FORBIDDEN",
          "É necessário redefinir a senha antes de entrar.",
        );
      case "challenge_required":
        throw new ServiceError(
          403,
          "FORBIDDEN",
          "O login exige uma etapa adicional que ainda não é suportada.",
        );
      case "rate_limited":
        throw new ServiceError(
          429,
          "RATE_LIMITED",
          "Muitas tentativas de login. Tente novamente em instantes.",
        );
      case "unavailable":
        throw new ServiceError(
          503,
          "FEATURE_UNAVAILABLE",
          "O provedor de identidade não está configurado.",
        );
      default: {
        const unhandled: never = outcome.reason;
        throw new ServiceError(
          500,
          "INTERNAL_ERROR",
          `Motivo de falha não tratado: ${String(unhandled)}`,
        );
      }
    }
  }
}

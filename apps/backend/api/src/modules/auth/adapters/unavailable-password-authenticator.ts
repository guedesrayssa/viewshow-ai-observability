import type {
  PasswordAuthOutcome,
  PasswordAuthenticatorPort,
} from "../ports/password-authenticator.js";

/**
 * Usado quando o Cognito não está configurado no ambiente. Falha fechada: sem
 * provedor, ninguém entra — o use case converte isto em 503.
 */
export class UnavailablePasswordAuthenticator
  implements PasswordAuthenticatorPort
{
  async authenticate(): Promise<PasswordAuthOutcome> {
    return { ok: false, reason: "unavailable" };
  }
}

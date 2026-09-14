/**
 * @file auth.ts
 * Cliente de autenticação do View Show.
 *
 * O navegador envia as credenciais somente ao backend. O backend mantém a
 * configuração confidencial do Cognito e devolve uma sessão por cookie.
 */

import { ALLOW_EXAMPLE_DATA } from "@/lib/data/mode";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { gatewayUrl, isApiConfigured } from "@/lib/data/client";

/** Aviso exibido quando o serviço de autenticação não pode ser acessado. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "Não foi possível entrar agora. Tente novamente em instantes.";

export type PasswordAuthenticationDecision =
  | { kind: "authenticated" }
  | { kind: "demo" }
  | { kind: "error"; message: string };

function authenticationErrorMessage(status: number): string {
  if (status === 401) return "E-mail ou senha incorretos.";
  if (status === 403)
    return "Este usuário ainda não está liberado para entrar.";
  if (status === 429)
    return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  return AUTH_UNAVAILABLE_MESSAGE;
}

/** Envia e-mail e senha ao backend, que autentica no Cognito e cria a sessão. */
export async function authenticateWithPassword(
  username: string,
  password: string,
): Promise<PasswordAuthenticationDecision> {
  if (!isApiConfigured()) {
    return ALLOW_EXAMPLE_DATA
      ? { kind: "demo" }
      : { kind: "error", message: AUTH_UNAVAILABLE_MESSAGE };
  }

  try {
    const response = await fetch(gatewayUrl(ENDPOINTS.auth.login), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ username: username.trim(), password }),
    });
    if (!response.ok) {
      return {
        kind: "error",
        message: authenticationErrorMessage(response.status),
      };
    }
    return { kind: "authenticated" };
  } catch {
    return { kind: "error", message: AUTH_UNAVAILABLE_MESSAGE };
  }
}

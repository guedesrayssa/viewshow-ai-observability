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

/**
 * Verdadeiro quando o login aceita qualquer e-mail e senha e abre o painel
 * com dado de exemplo. Mesma condição usada por `authenticateWithPassword`;
 * exportada para que a tela de login possa avisar antes de a pessoa tentar
 * entrar.
 */
export function isDemoModeActive(): boolean {
  return !isApiConfigured() && ALLOW_EXAMPLE_DATA;
}

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
  if (isDemoModeActive()) return { kind: "demo" };
  if (!isApiConfigured())
    return { kind: "error", message: AUTH_UNAVAILABLE_MESSAGE };

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

export type SessionRole = "viewer" | "engineer" | "admin";

/** Identidade da sessão em cookie, como devolvida por `GET /auth/session`. */
export type SessionIdentity = {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
  readonly role: SessionRole;
  /** Quando a sessão foi criada (login), em ISO 8601. */
  readonly issuedAt: string;
};

/**
 * Lê a sessão atual do backend. `null` cobre tanto "sem sessão" quanto
 * "API não configurada": em ambos os casos a tela de conta não tem uma
 * identidade real para mostrar.
 */
export async function fetchSessionIdentity(): Promise<SessionIdentity | null> {
  if (!isApiConfigured()) return null;
  try {
    const response = await fetch(gatewayUrl(ENDPOINTS.auth.session), {
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      data?: { user?: SessionIdentity };
    } | null;
    return body?.data?.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Encerra a sessão em cookie no backend. Sem API configurada não há cookie
 * para encerrar; a chamada é ignorada silenciosamente nesse caso.
 */
export async function signOut(): Promise<void> {
  if (!isApiConfigured()) return;
  try {
    await fetch(gatewayUrl(ENDPOINTS.auth.logout), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    // O cookie expira sozinho em até 8h mesmo se essa chamada falhar.
  }
}

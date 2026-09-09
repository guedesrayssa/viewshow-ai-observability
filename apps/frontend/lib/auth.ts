/**
 * @file auth.ts
 * Regras de acesso do View Show.
 *
 * A autenticação é delegada ao serviço de identidade (RIE01, RESTR01): a
 * aplicação apenas inicia o fluxo federado que o provedor controla.
 */

import { ALLOW_EXAMPLE_DATA } from "@/lib/data/mode";
import { ENDPOINTS } from "@/lib/data/endpoints";
import { gatewayUrl, isApiConfigured } from "@/lib/data/client";

/** Aviso exibido quando o SSO corporativo não está configurado no ambiente. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "A entrada por SSO Globo ainda não está disponível neste ambiente.";

export type AuthenticationDecision =
  | { kind: "demo" }
  | { kind: "redirect"; url: string }
  | { kind: "unavailable"; message: string };

/** Decide como iniciar o acesso sem enviar credenciais pelo frontend. */
export function beginAuthentication(): AuthenticationDecision {
  if (isApiConfigured()) {
    return { kind: "redirect", url: gatewayUrl(ENDPOINTS.auth.login) };
  }
  if (ALLOW_EXAMPLE_DATA) return { kind: "demo" };
  return { kind: "unavailable", message: AUTH_UNAVAILABLE_MESSAGE };
}

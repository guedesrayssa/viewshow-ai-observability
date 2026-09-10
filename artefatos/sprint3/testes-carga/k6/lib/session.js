/**
 * Login compartilhado pelos scripts desta pasta.
 *
 * Extraído de consultas.js/auth-check.js (sprint2) para não repetir a mesma
 * chamada de POST /auth/login em três arquivos. O contrato não mudou desde
 * então: e-mail/senha de desenvolvimento, cookie de sessão HttpOnly.
 */
import http from "k6/http";

/**
 * Autentica uma vez (chamar em `setup()`) e devolve o cookie de sessão.
 * Lança erro se a API não responder 200 ou não devolver o cookie — falha
 * cedo, no setup, em vez de poluir todas as iterações com 401.
 */
export function login(baseUrl, { email, password } = {}) {
  const res = http.post(
    `${baseUrl}/auth/login`,
    JSON.stringify({
      email: email || __ENV.AUTH_EMAIL || "demo@globoplay.com",
      password: password || __ENV.AUTH_PASSWORD || "demo123",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (res.status !== 200) {
    throw new Error(
      `Login falhou: HTTP ${res.status} em ${baseUrl}/auth/login. ` +
        "A API está de pé e IDENTITY_DEV_AUTH_ENABLED=true?",
    );
  }
  const cookie = res.cookies.session ? res.cookies.session[0].value : null;
  if (!cookie) throw new Error("Login OK (200) mas nenhum cookie 'session' voltou.");
  return cookie;
}

/** Monta os headers de uma chamada autenticada. */
export function authParams(cookie, tags = {}) {
  return { headers: { Cookie: `session=${cookie}` }, tags };
}

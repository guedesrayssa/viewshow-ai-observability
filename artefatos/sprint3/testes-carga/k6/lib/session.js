/**
 * Sessão compartilhada pelos scripts desta pasta.
 *
 * MUDOU (2026-09): não existe mais `POST /auth/login` com e-mail/senha. A
 * identidade agora é federada (Cognito/OIDC): `GET /auth/login` deveria
 * redirecionar (302) e `GET /auth/callback?code&state` completaria o login,
 * mas hoje as duas respondem 503 FEATURE_UNAVAILABLE — o adaptador
 * (`ConfiguredIdentityProvider` em `src/modules/auth/adapters/`) sempre
 * retorna `null`. Não há como logar via HTTP puro, nem localmente.
 *
 * Por isso este arquivo não faz mais nenhuma chamada HTTP: ele FORJA o
 * cookie de sessão diretamente, replicando o algoritmo de `SessionCodec`
 * (`apps/backend/api/src/modules/auth/domain/session.ts`):
 *
 *   payload = {id, email, name, role, issuedAt, expiresAt, sessionId}
 *   encoded = base64url(JSON(payload))                    // sem padding
 *   assinatura = HMAC-SHA256(AUTH_COOKIE_SECRET, encoded), base64url sem padding
 *   cookie = `${encoded}.${assinatura}`
 *
 * É o MESMO caminho que `apps/backend/api/tests/live-api.e2e.test.ts` usa
 * internamente (via `new SessionCodec(secret).issue({...})`) — não é um
 * hack deste script, é o padrão sancionado pelo próprio time para tráfego de
 * teste autenticado.
 *
 * Exige `-e AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob teste>`
 * em todo `k6 run`. Sem isso a API rejeita a assinatura e toda chamada
 * autenticada volta 401, mesmo com o resto do payload correto.
 */
import crypto from "k6/crypto";
import encoding from "k6/encoding";

const DEFAULT_LIFETIME_SECONDS = 8 * 60 * 60; // espelha SessionCodec (8h)

/**
 * Forja um cookie de sessão válido. Chamar em `setup()` — uma vez por run,
 * não por iteração — e propagar o valor via `data`.
 */
export function forgeSessionCookie({
  id,
  email,
  name = null,
  role = "engineer",
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
} = {}) {
  const secret = __ENV.AUTH_COOKIE_SECRET;
  if (!secret) {
    throw new Error(
      "Faltou -e AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob teste>. " +
        "Sem ele a assinatura HMAC não bate e a API responde 401 em toda rota autenticada.",
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    id: id || __ENV.AUTH_USER_ID || "k6-load-test",
    email: email || __ENV.AUTH_EMAIL || "k6-load-test@globoplay.com",
    name,
    role,
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
    sessionId: `k6-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  };

  // Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") no
  // Node equivale a encoding.b64encode(JSON.stringify(payload), "rawurl") no k6.
  const encoded = encoding.b64encode(JSON.stringify(payload), "rawurl");
  const signature = crypto.hmac("sha256", secret, encoded, "base64rawurl");
  return `${encoded}.${signature}`;
}

/** Monta os headers de uma chamada autenticada. */
export function authParams(cookie, tags = {}) {
  return { headers: { Cookie: `session=${cookie}` }, tags };
}

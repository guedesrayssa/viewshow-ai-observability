/**
 * Sessão compartilhada pelos scripts desta pasta.
 *
 * A identidade é federada (Cognito/OIDC): `GET /auth/login` deveria
 * redirecionar (302) e `GET /auth/callback?code&state` completaria o login,
 * mas hoje as duas respondem 503 FEATURE_UNAVAILABLE — o adaptador
 * (`ConfiguredIdentityProvider` em `src/modules/auth/adapters/`) sempre
 * retorna `null`. Não há `POST /auth/login` nem outra forma de logar via
 * HTTP puro.
 *
 * Por isso este arquivo não faz nenhuma chamada HTTP: ele FORJA o
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

let requestSequence = 0;

/**
 * Sequencial por chamada, único o bastante para correlacionar em Loki/Tempo:
 * VU+iteração já distinguem VUs paralelos de um cenário de carga, e o
 * contador cobre chamadas extras dentro da mesma iteração (ex.: paginação em
 * consultas.js, que faz duas requisições por iteração no cenário G).
 * Formato restrito a `[A-Za-z0-9_.:-]` porque é o que
 * `apps/backend/api/src/app.ts` (`requestIdentifier()`) aceita — fora disso
 * a API ignora o header e gera o próprio id.
 */
function nextRequestId(prefix) {
  requestSequence += 1;
  const vu = typeof __VU !== "undefined" ? __VU : 0;
  const iter = typeof __ITER !== "undefined" ? __ITER : 0;
  return `${prefix}-vu${vu}-it${iter}-${requestSequence}`;
}

/**
 * Header X-Request-Id para uma chamada. A API ecoa o valor recebido (em vez
 * de gerar um próprio) e grava em `request_id` no log JSON estruturado de
 * cada requisição (`src/app.ts`) — filtrável hoje na saída padrão do
 * processo da API por prefixo (`k6-consultas`, `k6-authcheck`,
 * `k6-ingestao`). Ainda NÃO chega a Loki: a stack de observabilidade local
 * não tem coletor de logs configurado (ver seção Observabilidade do
 * README). Uma vez que esse coletor existir, o mesmo campo já seria
 * suficiente para filtrar lá também, sem mudar nada aqui.
 */
export function requestIdHeader(prefix = "k6") {
  return { "X-Request-Id": nextRequestId(prefix) };
}

/**
 * Monta os headers de uma chamada autenticada. `prefix` rotula a origem no
 * X-Request-Id (ver requestIdHeader) — cada script chama com o próprio nome
 * para facilitar filtragem na stack de observabilidade.
 */
export function authParams(cookie, tags = {}, prefix = "k6") {
  return {
    headers: { Cookie: `session=${cookie}`, ...requestIdHeader(prefix) },
    tags,
  };
}

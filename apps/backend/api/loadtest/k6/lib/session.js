/**
 * Sessão compartilhada pelos scripts desta pasta. Duas formas de obter uma
 * sessão válida, escolha do chamador:
 *
 *   1. `loginSessionCookie()` — login de senha real contra o Cognito
 *      (`POST /auth/login`, provisionado em `apps/fullstack/cognito.tf`
 *      desde que o adaptador corporativo deixou de ser fail-closed). É o
 *      caminho de ponta a ponta de verdade e não exige conhecer nenhum
 *      segredo do processo da API — só um usuário de teste no User Pool.
 *   2. `forgeSessionCookie()` — FORJA o cookie diretamente, replicando o
 *      algoritmo de `SessionCodec`
 *      (`apps/backend/api/src/modules/auth/domain/session.ts`):
 *
 *        payload = {id, email, name, role, issuedAt, expiresAt, sessionId}
 *        encoded = base64url(JSON(payload))                    // sem padding
 *        assinatura = HMAC-SHA256(AUTH_COOKIE_SECRET, encoded), base64url sem padding
 *        cookie = `${encoded}.${assinatura}`
 *
 *      Útil quando não há um usuário Cognito à mão (ex.: API local sem
 *      Cognito configurado) mas exige `-e AUTH_COOKIE_SECRET=<mesmo segredo
 *      do processo da API sob teste>` — indisponível quando o segredo é
 *      gerado pelo Terraform (`random_password`) e nunca sai em texto
 *      claro. `GET /auth/login`/`GET /auth/callback` (federado) continuam
 *      503 FEATURE_UNAVAILABLE enquanto o SSO corporativo não for
 *      configurado — isso não afeta nenhum dos dois caminhos acima.
 */
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import http from "k6/http";

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

/**
 * Loga de verdade contra `POST /auth/login` e devolve o cookie de sessão que
 * a API emitiu. Chamar em `setup()` — uma vez por run — igual a
 * `forgeSessionCookie()`. Lança se o login falhar (credencial errada, User
 * Pool inexistente nesta stack etc.) para o run abortar cedo em vez de
 * gastar carga inteira recebendo 401.
 */
export function loginSessionCookie(baseUrl, username, password) {
  if (!username || !password) {
    throw new Error(
      "loginSessionCookie exige username e password (-e AUTH_USERNAME=... -e AUTH_PASSWORD=...).",
    );
  }
  const response = http.post(
    `${baseUrl}/auth/login`,
    JSON.stringify({ username, password }),
    { headers: { "Content-Type": "application/json" } },
  );
  if (response.status !== 200) {
    throw new Error(
      `POST /auth/login falhou (status ${response.status}): ${response.body}`,
    );
  }
  const setCookie = response.headers["Set-Cookie"];
  const match = setCookie ? setCookie.match(/session=([^;]+)/) : null;
  if (!match) {
    throw new Error(
      `POST /auth/login não devolveu cookie de sessão (Set-Cookie: ${setCookie}).`,
    );
  }
  return match[1];
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
 * `k6-ingestao`). Com `LOKI_PUSH_URL` definido na API as linhas chegam ao Loki,
 * e o mesmo ID leva ao trace no Grafana (atributo `viewshow.request_id` do span;
 * busca TraceQL `{ span.viewshow.request_id = "<id>" }`).
 */
export function requestIdHeader(prefix = "k6") {
  return { "X-Request-Id": nextRequestId(prefix) };
}

/**
 * Monta os headers de uma chamada autenticada. `prefix` rotula a origem no
 * X-Request-Id (ver requestIdHeader) — cada script chama com o próprio nome
 * para facilitar filtragem na stack de observabilidade. Inclui
 * Content-Type: application/json — necessário para POSTs com corpo (ex.:
 * ingestao-batch.js) serem parseados por express.json() (global, src/app.ts);
 * sem ele o corpo chega como undefined e a rota reprova a validação do
 * schema antes de qualquer lógica de negócio. Confirmado rodando localmente
 * contra POST /api/v1/imports (sem isto, 400 VALIDATION_ERROR em vez do 503
 * FEATURE_UNAVAILABLE esperado). Inofensivo em GETs, que não têm corpo.
 */
export function authParams(cookie, tags = {}, prefix = "k6") {
  return {
    headers: {
      Cookie: `session=${cookie}`,
      "Content-Type": "application/json",
      ...requestIdHeader(prefix),
    },
    tags,
  };
}

/**
 * Igual a `authParams`, mas também devolve o `X-Request-Id` gerado — para
 * quem precisa comparar o valor enviado com o que a API ecoa de volta
 * (`consultas.js`, checks de correlação da Seção 4 de
 * artefatos/sprint4/testes-funcionais.md). `authParams` continua sem esse
 * retorno para não mudar a assinatura usada por `auth-check.js` e
 * `ingestao-batch.js`.
 */
export function authParamsWithRequestId(cookie, tags = {}, prefix = "k6") {
  const idHeader = requestIdHeader(prefix);
  return {
    params: {
      headers: {
        Cookie: `session=${cookie}`,
        "Content-Type": "application/json",
        ...idHeader,
      },
      tags,
    },
    requestId: idHeader["X-Request-Id"],
  };
}

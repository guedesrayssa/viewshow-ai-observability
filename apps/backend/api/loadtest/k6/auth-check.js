/**
 * Verificação de controle de acesso da API do View Show (RNF04). Não é teste
 * de carga: uma única iteração confirma, para cada rota, que uma chamada sem
 * sessão (ou com cookie inválido) é recusada e que a sessão válida chega ao
 * resultado esperado.
 *
 * ESTADO ATUAL DO CONTROLE DE ACESSO (src/app.ts):
 *   - Chamam `auth.sessions.verify()`: GET /auth/session, PATCH .../review,
 *     POST .../reanalyze e as três rotas de /api/v1/imports*. `auth_session`
 *     é o único ponto de controle já conforme ao RNF04 hoje.
 *   - As rotas de consulta (incidents, dashboard/overview, monitoring/
 *     overview, diagnosis, events) são públicas — respondem sem cookie. As
 *     asserções "sem cookie → 401" nelas descrevem o estado-alvo do RNF04 e
 *     reprovam por design até essa proteção existir; é o gap que este script
 *     existe para revelar, não uma falha do teste.
 *   - GET /api/v1/incidents/:id/events/:eventId não olha sessão nenhuma (rota
 *     stub, sempre 503) — marcada `semGuardaAlguma: true` para não confundir
 *     com o gap acima.
 *   - GET /auth/login e /auth/callback são fail-closed incondicionais (503,
 *     login federado sem adaptador configurado) — não é controle de acesso,
 *     por isso ficam fora da matriz principal (`objetivo: "gap-conhecido"`).
 *     POST /auth/logout é 204 incondicional (idempotente por design).
 *   - Import/reanalyze validam corpo/header antes de checar sessão, por isso
 *     as três variantes de cada rota sempre mandam corpo/headers válidos.
 *
 * Rotas mutáveis (PATCH review, POST reanalyze) usam um ID cuja inexistência
 * é comprovada no setup, para nunca alterar um incidente real.
 *
 * USO:
 *   k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<32+ chars> auth-check.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { forgeSessionCookie, requestIdHeader } from "./lib/session.js";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");

export const options = {
  // setupTimeout > 61s: setup() pode esperar uma janela inteira do rate
  // limiter (ver probe abaixo) antes de seguir.
  setupTimeout: "90s",
  scenarios: {
    verificacao: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "1m" },
  },
  thresholds: {
    // rate==1 torna qualquer rota fora do esperado uma falha do run, sem
    // diluir o resultado entre checks informativos.
    "checks{objetivo:rnf04}": ["rate==1"],
  },
};

export function setup() {
  const validCookie = forgeSessionCookie({ role: "engineer" });

  // O GET autenticado torna a inexistência uma pré-condição comprovada, não
  // uma suposição baseada no formato dos IDs do seed.
  const nonexistentId = `auth-check-ausente-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const probeUrl = `${BASE_URL}/api/v1/incidents/${encodeURIComponent(nonexistentId)}/diagnosis`;
  const probeParams = { headers: { Cookie: `session=${validCookie}` } };
  let probe = http.get(probeUrl, probeParams);
  if (probe.status === 429) {
    // O rate limiter (180 req/min por IP, src/app.ts) é uma janela de 60s
    // que pode ter sobrado de um run anterior contra o mesmo BASE_URL
    // (confirmado rodando smoke + auth-check em sequência local). Uma
    // única espera cobre o pior caso e evita reprovar por um motivo que
    // não tem nada a ver com o script em si.
    sleep(61);
    probe = http.get(probeUrl, probeParams);
  }
  if (probe.status === 429) {
    throw new Error(
      "Rate limiter (180 req/min por IP) ainda ativo após esperar 61s — " +
        "confira se outro processo está gerando tráfego contra o mesmo BASE_URL.",
    );
  }
  if (probe.status !== 404) {
    throw new Error(
      `Não foi possível garantir um ID inexistente: GET autenticado retornou HTTP ${probe.status}.`,
    );
  }

  return { validCookie, nonexistentId };
}

/**
 * Matriz das rotas cobertas pelo RNF04. `expectedAuthenticated` é explícito
 * para não confundir 401/403, rota inexistente ou erro 500 com uma chamada
 * autenticada bem-sucedida. `semGuardaAlguma` marca a única rota que nem
 * tenta verificar sessão (ver cabeçalho). `body`/`headers` são o
 * corpo/headers válidos que TODAS as três variantes (sem cookie, cookie
 * inválido, cookie válido) enviam, para as rotas que validam entrada antes
 * de checar sessão.
 */
function rotas(id) {
  const encodedId = encodeURIComponent(id);

  return [
    // Contraste deliberado: única rota da matriz que JÁ cumpre o RNF04 hoje
    // (chama auth.sessions.verify() de verdade) — as três asserções abaixo
    // devem passar de ponta a ponta, ao contrário das rotas de leitura.
    { tag: "auth_session", method: "GET", path: "/auth/session", expectedAuthenticated: 200 },
    { tag: "dashboard_overview", method: "GET", path: "/api/v1/dashboard/overview", expectedAuthenticated: [200, 503] },
    { tag: "incidents_list", method: "GET", path: "/api/v1/incidents", expectedAuthenticated: 200 },
    { tag: "incident_diagnosis", method: "GET", path: `/api/v1/incidents/${encodedId}/diagnosis`, expectedAuthenticated: 404 },
    { tag: "incident_events", method: "GET", path: `/api/v1/incidents/${encodedId}/events`, expectedAuthenticated: 404 },
    {
      tag: "incident_event_detail",
      method: "GET",
      path: `/api/v1/incidents/${encodedId}/events/evt-inexistente`,
      expectedAuthenticated: 503,
      semGuardaAlguma: true,
    },
    { tag: "monitoring_overview", method: "GET", path: "/api/v1/monitoring/overview", expectedAuthenticated: [200, 503] },
    {
      tag: "hypothesis_review",
      method: "PATCH",
      path: `/api/v1/incidents/${encodedId}/hypotheses/hyp-inexistente/review`,
      body: JSON.stringify({ status: "refuted", expectedVersion: 0 }),
      expectedAuthenticated: 404,
    },
    {
      // Idempotency-Key não afeta o resultado aqui: a rota sempre 404 antes
      // de olhar para deduplicação (incidente inexistente checado primeiro).
      tag: "reanalyze",
      method: "POST",
      path: `/api/v1/incidents/${encodedId}/reanalyze`,
      headers: { "Idempotency-Key": `k6-authcheck-${id}` },
      expectedAuthenticated: 404,
    },
    {
      // O adaptador (UnavailableImportControl) é fail-closed incondicional:
      // não importa o corpo/ID, sempre 503 FEATURE_UNAVAILABLE — não precisa
      // de prova de inexistência.
      tag: "import_start",
      method: "POST",
      path: "/api/v1/imports",
      body: JSON.stringify({
        fileName: "auth-check-probe.ndjson",
        sizeBytes: 1024,
        sha256: "0".repeat(64),
        partCount: 1,
      }),
      expectedAuthenticated: 503,
    },
    {
      tag: "import_complete",
      method: "POST",
      path: "/api/v1/imports/imp-auth-check-inexistente/complete",
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag-fake" }] }),
      expectedAuthenticated: 503,
    },
    {
      tag: "import_status",
      method: "GET",
      path: "/api/v1/imports/imp-auth-check-inexistente",
      expectedAuthenticated: 503,
    },
  ];
}

/** Cookie explícito evita que os três casos dependam do cookie jar do k6. */
function chamar(rota, cookieHeader) {
  const params = {
    headers: {
      // Content-Type só quando há corpo de verdade: express.json() (global,
      // src/app.ts) engata em QUALQUER request Content-Type: application/json
      // e resolve req.body para {} mesmo sem bytes — em rotas sem corpo
      // (reanalyze) isso quebra a validação z.undefined() da rota com 400
      // VALIDATION_ERROR antes mesmo de checar sessão, mascarando o sinal de
      // RNF04. Confirmado rodando contra a API local.
      ...(rota.body ? { "Content-Type": "application/json" } : {}),
      ...requestIdHeader("k6-authcheck"),
      ...(rota.headers || {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    tags: { rota: rota.tag },
  };
  return http.request(rota.method, `${BASE_URL}${rota.path}`, rota.body || null, params);
}

function statusEsperadoOk(status, expected) {
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

/**
 * GET /auth/login, GET /auth/callback e POST /auth/logout ficam fora da
 * matriz principal porque nenhum dos três chama auth.sessions.verify() — não
 * são sobre controle de acesso, então misturá-los em `objetivo: "rnf04"`
 * diluiria esse sinal. login/callback são fail-closed incondicionais
 * (503 FEATURE_UNAVAILABLE, login federado não configurado — ver cabeçalho);
 * logout é incondicionalmente 204 (idempotente por design).
 */
function verificarRotasSemGuardaDeSessao() {
  const paramsBase = { headers: { ...requestIdHeader("k6-authcheck") } };

  const login = http.get(`${BASE_URL}/auth/login`, {
    ...paramsBase,
    redirects: 0,
    tags: { rota: "auth_login" },
  });
  check(
    login,
    { "auth_login: 503 FEATURE_UNAVAILABLE (login federado ainda não configurado)": (r) => r.status === 503 },
    { rota: "auth_login", objetivo: "gap-conhecido" },
  );

  const callback = http.get(`${BASE_URL}/auth/callback?code=probe&state=probe`, {
    ...paramsBase,
    redirects: 0,
    tags: { rota: "auth_callback" },
  });
  check(
    callback,
    { "auth_callback: 503 FEATURE_UNAVAILABLE (login federado ainda não configurado)": (r) => r.status === 503 },
    { rota: "auth_callback", objetivo: "gap-conhecido" },
  );

  const logout = http.post(`${BASE_URL}/auth/logout`, null, {
    ...paramsBase,
    tags: { rota: "auth_logout" },
  });
  check(
    logout,
    { "auth_logout: 204 mesmo sem sessão (idempotente por design)": (r) => r.status === 204 },
    { rota: "auth_logout", objetivo: "contrato" },
  );
}

export default function (data) {
  verificarRotasSemGuardaDeSessao();

  for (const rota of rotas(data.nonexistentId)) {
    const semCookie = chamar(rota, null);
    const cookieInvalido = chamar(rota, "session=cookie-forjado-para-teste");
    const cookieValido = chamar(rota, `session=${data.validCookie}`);
    const tags = { rota: rota.tag, objetivo: "rnf04" };
    const rotuloEsperado = Array.isArray(rota.expectedAuthenticated)
      ? rota.expectedAuthenticated.join(" ou ")
      : rota.expectedAuthenticated;

    if (rota.semGuardaAlguma) {
      // Não afirmamos 401 aqui: documentamos o estado real (a rota responde
      // igual com ou sem sessão) como um check separado, fora do objetivo
      // rnf04, para não misturar "gap conhecido de RNF04" com "sem guarda".
      check(
        semCookie,
        { [`${rota.tag}: sem guarda de sessão (responde ${rotuloEsperado} mesmo sem cookie)`]: (r) => statusEsperadoOk(r.status, rota.expectedAuthenticated) },
        { rota: rota.tag, objetivo: "gap-conhecido" },
      );
      continue;
    }

    check(semCookie, { [`${rota.tag}: 401 sem cookie`]: (r) => r.status === 401 }, tags);
    check(cookieInvalido, { [`${rota.tag}: 401 com cookie inválido`]: (r) => r.status === 401 }, tags);
    check(
      cookieValido,
      { [`${rota.tag}: autenticado retorna ${rotuloEsperado}`]: (r) => statusEsperadoOk(r.status, rota.expectedAuthenticated) },
      tags,
    );
  }
}

export function handleSummary(data) {
  const linhas = [
    "Verificação de controle de acesso (RNF04) — resumo",
    "",
    "Alvo: sem sessão/com cookie inválido → 401. Com sessão válida → status explícito da matriz.",
    "incident_event_detail não tem guarda de sessão nenhuma (rota-stub, sempre 503) — checada à parte, fora de 'objetivo:rnf04'.",
    "import_start/import_complete/import_status são fail-closed por design (503 FEATURE_UNAVAILABLE) — não é bug.",
    "auth_session já cumpre o RNF04 hoje (contraste com as rotas de leitura, que ainda não cumprem).",
    "auth_login/auth_callback são fail-closed incondicionais (login federado não configurado) — não é RNF04, é feature desligada.",
    "",
    "Detalhe por checagem:",
  ];

  for (const resultado of data.root_group.checks || []) {
    const marca = resultado.fails > 0 ? "✗" : "✓";
    linhas.push(`  ${marca} ${resultado.name} (passou ${resultado.passes}x, falhou ${resultado.fails}x)`);
  }

  const checks = data.metrics.checks?.values || { passes: 0, fails: 0 };
  linhas.push(`\nChecks: ${checks.passes} passaram, ${checks.fails} falharam.`);
  return { stdout: linhas.join("\n") + "\n" };
}

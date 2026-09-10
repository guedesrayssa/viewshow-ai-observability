/**
 * Verificação de controle de acesso da API do View Show (RNF04).
 *
 * Sucessor de artefatos/sprint2/testes-carga/k6/auth-check.js, com a matriz
 * de rotas atualizada para o contrato atual (ver cabeçalho de consultas.js
 * para o mapeamento rota antiga → rota atual). Não é teste de carga: uma
 * única iteração confirma que cada rota recusa chamada sem sessão/com cookie
 * forjado, e continua alcançável com sessão válida.
 *
 * MUDOU (2026-09):
 *   - Autenticação: não existe mais POST /auth/login. `lib/session.js` forja
 *     o cookie de sessão localmente (HMAC, mesmo algoritmo de SessionCodec) —
 *     exige `-e AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob
 *     teste>`.
 *   - Rotas novas cobertas pela matriz: POST .../reanalyze (exige header
 *     Idempotency-Key) e as três de /api/v1/imports* (POST /imports, POST
 *     /imports/:id/complete, GET /imports/:id).
 *
 * ESTADO REAL HOJE (não é bug deste script — é o que o código faz):
 *   - Em src/app.ts, chamam auth.sessions.verify(): PATCH .../review, POST
 *     .../reanalyze e as três rotas de /api/v1/imports*. Todas as rotas GET
 *     de consulta (incidents, dashboard/overview, monitoring/overview,
 *     diagnosis, events) são públicas hoje — respondem 200/404/503 sem
 *     qualquer cookie. As asserções "sem cookie → 401" abaixo descrevem o
 *     estado-ALVO do RNF04 e vão falhar até essa proteção ser aplicada às
 *     demais rotas; é exatamente esse gap que este script existe para
 *     detectar.
 *   - GET /api/v1/incidents/:id/events/:eventId é um caso à parte: o handler
 *     nem chega a olhar sessão — sempre responde 503 DATA_UNAVAILABLE (rota
 *     ainda não implementada, incidents.event() em incident-use-cases.ts).
 *     Está marcada abaixo com `semGuardaAlguma: true` para não confundir
 *     "ainda não tem RNF04 aplicado" com "não tem guarda nenhuma".
 *   - As rotas de import/reanalyze validam corpo/header ANTES de checar
 *     sessão — por isso as três variantes (sem cookie/cookie inválido/cookie
 *     válido) sempre mandam corpo/headers válidos; senão "sem cookie"
 *     mediria 400 de validação, não o controle de acesso.
 *
 * As rotas mutáveis (PATCH review, POST reanalyze) usam IDs cuja
 * inexistência é comprovada no setup antes da chamada, para nunca alterar um
 * incidente real. As rotas de import respondem 503 FEATURE_UNAVAILABLE
 * incondicionalmente (adaptador fail-closed) — não precisam dessa prova.
 *
 * USO:
 *   k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<32+ chars> auth-check.js
 */

import http from "k6/http";
import { check } from "k6";
import { forgeSessionCookie } from "./lib/session.js";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");

export const options = {
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
  const probe = http.get(
    `${BASE_URL}/api/v1/incidents/${encodeURIComponent(nonexistentId)}/diagnosis`,
    { headers: { Cookie: `session=${validCookie}` } },
  );
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
      "Content-Type": "application/json",
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

export default function (data) {
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

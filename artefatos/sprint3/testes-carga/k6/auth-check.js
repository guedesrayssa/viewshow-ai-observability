/**
 * Verificação de controle de acesso da API do View Show (RNF04).
 *
 * Sucessor de artefatos/sprint2/testes-carga/k6/auth-check.js, com a matriz
 * de rotas atualizada para o contrato atual (ver cabeçalho de consultas.js
 * para o mapeamento rota antiga → rota atual). Não é teste de carga: uma
 * única iteração confirma que cada rota recusa chamada sem sessão/com cookie
 * forjado, e continua alcançável com sessão válida.
 *
 * ESTADO REAL HOJE (não é bug deste script — é o que o código faz):
 *   - Em src/app.ts, SOMENTE a rota PATCH .../hypotheses/:id/review chama
 *     auth.sessions.verify(). Todas as rotas GET de consulta (incidents,
 *     dashboard/overview, monitoring/overview, diagnosis, events) são
 *     públicas hoje — respondem 200/404/503 sem qualquer cookie. As
 *     asserções "sem cookie → 401" abaixo descrevem o estado-ALVO do RNF04 e
 *     vão falhar até essa proteção ser aplicada às demais rotas; é
 *     exatamente esse gap que este script existe para detectar.
 *   - GET /api/v1/incidents/:id/events/:eventId é um caso à parte: o handler
 *     nem chega a olhar sessão — sempre responde 503 DATA_UNAVAILABLE (rota
 *     ainda não implementada, incidents.event() em incident-use-cases.ts).
 *     Está marcada abaixo com `semGuardaAlguma: true` para não confundir
 *     "ainda não tem RNF04 aplicado" com "não tem guarda nenhuma".
 *
 * As rotas mutáveis (PATCH review) usam IDs cuja inexistência é comprovada
 * no setup antes da chamada, para nunca revisar uma hipótese real.
 *
 * USO:
 *   k6 run -e BASE_URL=http://localhost:3000 auth-check.js
 */

import http from "k6/http";
import { check } from "k6";
import { login } from "./lib/session.js";

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
  const validCookie = login(BASE_URL);

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
 * tenta verificar sessão (ver cabeçalho).
 */
function rotas(id) {
  const encodedId = encodeURIComponent(id);

  return [
    { tag: "dashboard_overview", method: "GET", path: "/api/v1/dashboard/overview", expectedAuthenticated: 503 },
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
    { tag: "monitoring_overview", method: "GET", path: "/api/v1/monitoring/overview", expectedAuthenticated: 503 },
    {
      tag: "hypothesis_review",
      method: "PATCH",
      path: `/api/v1/incidents/${encodedId}/hypotheses/hyp-inexistente/review`,
      body: JSON.stringify({ status: "refuted", expectedVersion: 0 }),
      expectedAuthenticated: 404,
    },
  ];
}

/** Cookie explícito evita que os três casos dependam do cookie jar do k6. */
function chamar(rota, cookieHeader) {
  const params = {
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    tags: { rota: rota.tag },
  };
  return http.request(rota.method, `${BASE_URL}${rota.path}`, rota.body || null, params);
}

export default function (data) {
  for (const rota of rotas(data.nonexistentId)) {
    const semCookie = chamar(rota, null);
    const cookieInvalido = chamar(rota, "session=cookie-forjado-para-teste");
    const cookieValido = chamar(rota, `session=${data.validCookie}`);
    const tags = { rota: rota.tag, objetivo: "rnf04" };

    if (rota.semGuardaAlguma) {
      // Não afirmamos 401 aqui: documentamos o estado real (a rota responde
      // igual com ou sem sessão) como um check separado, fora do objetivo
      // rnf04, para não misturar "gap conhecido de RNF04" com "sem guarda".
      check(
        semCookie,
        { [`${rota.tag}: sem guarda de sessão (responde ${rota.expectedAuthenticated} mesmo sem cookie)`]: (r) => r.status === rota.expectedAuthenticated },
        { rota: rota.tag, objetivo: "gap-conhecido" },
      );
      continue;
    }

    check(semCookie, { [`${rota.tag}: 401 sem cookie`]: (r) => r.status === 401 }, tags);
    check(cookieInvalido, { [`${rota.tag}: 401 com cookie inválido`]: (r) => r.status === 401 }, tags);
    check(
      cookieValido,
      { [`${rota.tag}: autenticado retorna ${rota.expectedAuthenticated}`]: (r) => r.status === rota.expectedAuthenticated },
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

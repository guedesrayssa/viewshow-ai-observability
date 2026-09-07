/**
 * Verificação de controle de acesso da API do View Show (RNF04).
 *
 * Não é teste de carga: uma única iteração confirma que todas as rotas de
 * consulta, diagnóstico e curadoria recusam chamadas sem sessão ou com cookie
 * forjado, e continuam alcançáveis com uma sessão válida.
 *
 * As rotas potencialmente mutáveis usam um ID cuja inexistência é comprovada
 * no setup antes do PATCH/POST. Assim, o teste nunca revisa uma hipótese real
 * nem cria um diagnóstico.
 *
 * USO:
 *   k6 run -e BASE_URL=http://<host>:3000 auth-check.js
 */

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");

export const options = {
  scenarios: {
    verificacao: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "1m",
    },
  },
  thresholds: {
    // rate==1 torna qualquer rota sem proteção (ou inacessível autenticada)
    // uma falha do run, sem diluir o resultado entre checks informativos.
    "checks{objetivo:rnf04}": ["rate==1"],
  },
};

function cookieParams(cookie) {
  return { headers: { Cookie: `session=${cookie}` } };
}

export function setup() {
  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: __ENV.AUTH_EMAIL || "demo@globoplay.com",
      password: __ENV.AUTH_PASSWORD || "demo123",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (login.status !== 200) {
    throw new Error(`Login falhou: HTTP ${login.status}. A API está de pé em ${BASE_URL}?`);
  }

  const validCookie = login.cookies.session ? login.cookies.session[0].value : null;
  if (!validCookie) throw new Error("Login OK mas nenhum cookie 'session' voltou.");

  // O GET autenticado torna a inexistência uma pré-condição comprovada, não
  // uma suposição baseada no formato dos IDs usados pelo seed.
  const nonexistentId = `auth-check-ausente-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const probe = http.get(
    `${BASE_URL}/api/v1/incidents/${encodeURIComponent(nonexistentId)}`,
    cookieParams(validCookie),
  );
  if (probe.status !== 404) {
    throw new Error(
      `Não foi possível garantir um ID inexistente: GET autenticado retornou HTTP ${probe.status}.`,
    );
  }

  return { validCookie, nonexistentId };
}

/**
 * Matriz completa das rotas cobertas pelo RNF04. expectedAuthenticated é
 * explícito para não confundir 401/403, rota inexistente ou erro 500 com uma
 * chamada autenticada bem-sucedida.
 */
function rotas(id) {
  const encodedId = encodeURIComponent(id);
  const missingSignature = encodeURIComponent(`__AUTH_CHECK__#${id}#AUSENTE`);

  return [
    { tag: "incidents_list", method: "GET", path: "/api/v1/incidents", expectedAuthenticated: 200 },
    {
      tag: "incident_detail",
      method: "GET",
      path: `/api/v1/incidents/${encodedId}`,
      expectedAuthenticated: 404,
    },
    {
      tag: "incident_evidence",
      method: "GET",
      path: `/api/v1/incidents/${encodedId}/evidence`,
      expectedAuthenticated: 200,
    },
    {
      tag: "incident_hypothesis",
      method: "GET",
      path: `/api/v1/incidents/${encodedId}/hypothesis`,
      expectedAuthenticated: 404,
    },
    { tag: "dashboard_summary", method: "GET", path: "/api/v1/dashboard/summary", expectedAuthenticated: 200 },
    {
      tag: "golden_set",
      method: "GET",
      path: `/api/v1/golden-set?signature=${missingSignature}`,
      expectedAuthenticated: 404,
    },
    {
      tag: "hypothesis_review",
      method: "PATCH",
      path: `/api/v1/incidents/${encodedId}/hypothesis/review`,
      body: JSON.stringify({ status: "refuted" }),
      expectedAuthenticated: 404,
    },
    {
      tag: "incident_diagnose",
      method: "POST",
      path: `/api/v1/incidents/${encodedId}/diagnose`,
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

    check(semCookie, { [`${rota.tag}: 401 sem cookie`]: (r) => r.status === 401 }, tags);
    check(
      cookieInvalido,
      { [`${rota.tag}: 401 com cookie inválido`]: (r) => r.status === 401 },
      tags,
    );
    check(
      cookieValido,
      {
        [`${rota.tag}: autenticado retorna ${rota.expectedAuthenticated}`]:
          (r) => r.status === rota.expectedAuthenticated,
      },
      tags,
    );
  }
}

export function handleSummary(data) {
  const linhas = [
    "Verificação de controle de acesso (RNF04) — resumo",
    "",
    "Todas as rotas devem retornar 401 sem sessão e com cookie inválido.",
    "Com sessão válida, cada rota deve retornar o status explícito da matriz.",
    "PATCH /hypothesis/review e POST /diagnose usam um incidente comprovadamente inexistente.",
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

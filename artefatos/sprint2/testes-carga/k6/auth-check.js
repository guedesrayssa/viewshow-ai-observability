/**
 * Verificação de controle de acesso da API de consulta do View Show (RNF04).
 *
 * Isto NÃO é um teste de carga — é um script funcional/de segurança que
 * dispara pouco tráfego e confere o comportamento de autenticação de cada
 * rota. Existe porque o RNF04 (requisitos.md) diz que "o painel de
 * visualização e as APIs de consulta devem permitir acesso apenas via
 * autenticação", mas o código hoje (apps/backend/api/src/routes/incidents.js)
 * só aplica `requireAuth` em UMA rota: PATCH /:id/hypothesis/review.
 *
 * Este script documenta o estado REAL, não o aspiracional: rotas marcadas
 * `protegidaHoje: false` na matriz abaixo respondem sem sessão por desenho
 * atual do código, não por bug deste script. Só a rota protegida hoje entra
 * no threshold que reprova o run — as demais são só informativas, para não
 * confundir "gap de escopo conhecido" com "regressão".
 *
 * A implementação de auth (cookie HMAC, src/auth/session.js) também não é o
 * RIE01 (SSO federado da Globo) — esse é outro requisito, não coberto aqui.
 *
 * USO:
 *   k6 run -e BASE_URL=http://<host>:3000 auth-check.js
 *   k6 run -e BASE_URL=http://<host>:3000 -e SAMPLE_INCIDENT_ID=inc-000042 auth-check.js
 */

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");

// Qualquer incidente que exista na base já serve: a checagem de "autenticado
// não é bloqueado" aceita 200 OU 404 (ver `chamar()` abaixo) — o que importa
// é nunca ver 401 quando a sessão é válida. Rode seed.js ou seed-carga.js
// antes se a base estiver vazia.
const SAMPLE_INCIDENT_ID = __ENV.SAMPLE_INCIDENT_ID || "inc-000001";

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
    // A ÚNICA rota hoje atrás de requireAuth não pode aceitar acesso sem
    // sessão válida. Isto é o que efetivamente reprova o run.
    "checks{rota:hypothesis_review}": ["rate==1"],
  },
};

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
  return { validCookie };
}

/**
 * Matriz de rotas de consulta/curadoria. `protegidaHoje` reflete o código
 * (grep por requireAuth em apps/backend/api/src/routes), não o RNF04.
 *
 * `refuted` em vez de `confirmed` no body do PATCH: "refuted" nunca promove
 * caso à golden set (evidenceService.js), então este script não corrompe
 * dado curado ao exercitar a única rota protegida.
 */
function rotas(id) {
  return [
    { tag: "incidents_list", method: "GET", path: "/api/v1/incidents", protegidaHoje: false },
    { tag: "incident_detail", method: "GET", path: `/api/v1/incidents/${id}`, protegidaHoje: false },
    { tag: "incident_evidence", method: "GET", path: `/api/v1/incidents/${id}/evidence`, protegidaHoje: false },
    { tag: "incident_hypothesis", method: "GET", path: `/api/v1/incidents/${id}/hypothesis`, protegidaHoje: false },
    { tag: "dashboard_summary", method: "GET", path: "/api/v1/dashboard/summary", protegidaHoje: false },
    { tag: "golden_set", method: "GET", path: `/api/v1/golden-set?signature=${encodeURIComponent("Player#Smart TV#Nordeste")}`, protegidaHoje: false },
    {
      tag: "hypothesis_review",
      method: "PATCH",
      path: `/api/v1/incidents/${id}/hypothesis/review`,
      protegidaHoje: true,
      body: JSON.stringify({ status: "refuted" }),
    },
  ];
}

/** Uma chamada com um cabeçalho Cookie explícito — nunca usa o cookie jar
 *  automático do k6, então "sem cookie" e "cookie inválido" ficam garantidos
 *  independentes do que aconteceu no setup(). */
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
  for (const rota of rotas(SAMPLE_INCIDENT_ID)) {
    const semCookie = chamar(rota, null);
    const cookieInvalido = chamar(rota, "session=cookie-forjado-para-teste");
    const cookieValido = chamar(rota, `session=${data.validCookie}`);

    if (rota.protegidaHoje) {
      check(semCookie, { [`${rota.tag}: 401 sem cookie`]: (r) => r.status === 401 }, { rota: rota.tag });
      check(cookieInvalido, { [`${rota.tag}: 401 com cookie inválido`]: (r) => r.status === 401 }, { rota: rota.tag });
      // 404 é aceitável aqui (incidente de amostra sem hipótese registrada);
      // o que a checagem garante é que a sessão válida NUNCA é bloqueada.
      check(
        cookieValido,
        { [`${rota.tag}: autenticado não é bloqueado (200/404, nunca 401)`]: (r) => r.status !== 401 },
        { rota: rota.tag },
      );
    } else {
      // Informativo: documenta o gap conhecido do RNF04, não reprova o run.
      check(
        semCookie,
        { [`⚠ ${rota.tag}: hoje ACESSÍVEL sem sessão (gap RNF04 conhecido, não é falha deste script)`]: (r) => r.status !== 500 },
        { rota: rota.tag, gap_rnf04: "true" },
      );
    }
  }
}

export function handleSummary(data) {
  const linhas = ["Verificação de controle de acesso (RNF04) — resumo\n"];
  linhas.push("Rota protegida hoje (requireAuth):");
  linhas.push("  PATCH /api/v1/incidents/:id/hypothesis/review\n");
  linhas.push("Rotas de consulta SEM autenticação hoje (gap conhecido, não corrigido nesta rodada):");
  linhas.push("  GET /api/v1/incidents, /incidents/:id, /incidents/:id/evidence,");
  linhas.push("  /incidents/:id/hypothesis, /dashboard/summary, /golden-set\n");
  linhas.push("Detalhe por checagem:");
  // data.root_group.checks é uma lista (não um mapa) nesta versão do k6.
  for (const resultado of data.root_group.checks || []) {
    const marca = resultado.fails > 0 ? "✗" : "✓";
    linhas.push(`  ${marca} ${resultado.name} (passou ${resultado.passes}x, falhou ${resultado.fails}x)`);
  }
  linhas.push(`\nChecks: ${data.metrics.checks.values.passes} passaram, ${data.metrics.checks.values.fails} falharam.`);
  return {
    stdout: linhas.join("\n") + "\n",
  };
}

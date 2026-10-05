/**
 * Carga mista nas rotas da API consumidas pelo frontend View Show.
 *
 * O frontend é um export estático (Next.js `output: "export"`, hospedado no
 * Amplify): todo o trabalho do lado servidor que ele causa é HTTP contra esta
 * API, então este script mede a API com o padrão de chamadas do painel — não
 * mede a entrega dos assets estáticos nem o tempo de renderização no navegador
 * (para isso, veja a seção "O que este teste não mede" do README).
 *
 * Não chama ingestão, LLM, login Cognito nem operações que alterem dados. A
 * sessão é preparada uma vez no setup, e cada requisição leva um request id.
 *
 * Fidelidade ao frontend (apps/frontend/lib/data/client.ts):
 *   - timeout de 8 s por requisição (`REQUEST_TIMEOUT`): acima disso o painel
 *     desiste e mostra o bloco como indisponível, então aqui também é falha;
 *   - 200 só conta se trouxer o envelope `{data, meta}` que o painel valida;
 *   - paginação por cursor existe na tela de Eventos (não na de Incidentes).
 */
import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import {
  authParamsWithRequestId,
  forgeSessionCookie,
  loginSessionCookie,
} from "./lib/session.js";
import {
  checkGatewayEnvelope,
  checkIncidentsSchema,
  checkNoDuplicateIds,
  checkNoPhysicalFields,
  checkRequestIdEcho,
  parseBody,
} from "./lib/asserts.js";

const BASE_URL = (__ENV.BASE_URL || "").replace(/\/$/, "");
const MODE = __ENV.MODE || "smoke";
const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || "30m";
const INCIDENT_COUNT = Number(__ENV.INCIDENT_COUNT || 300);
// `synthetic` (padrão): sorteia inc-000001..inc-<INCIDENT_COUNT>, os IDs do seed-carga.
// `discover`: lê os IDs na própria API (`GET /api/v1/incidents?window=all`), para medir um
// dataset real sem semear nada. `WINDOW_OVERRIDE=all` troca as janelas das rotas de
// incidentes e eventos (um dataset real costuma estar fora da janela de 24 h).
const INCIDENT_IDS = __ENV.INCIDENT_IDS || "synthetic";
const WINDOW_OVERRIDE = __ENV.WINDOW_OVERRIDE || "";
const AUTH_USERNAME = __ENV.AUTH_USERNAME;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD;
const RESULTS_DIR = (__ENV.RESULTS_DIR || ".").replace(/\/$/, "");
// `unavailable`: só 503 DATA_UNAVAILABLE é aceito (projeção ainda inexistente);
// `available`: só 200; `either` (padrão): qualquer um dos dois.
const MONITORING_EXPECTED = __ENV.MONITORING_EXPECTED || "either";
const PREFLIGHT = __ENV.PREFLIGHT !== "0";
const FOLLOWUP_PROBABILITY =
  __ENV.FOLLOWUP_PROBABILITY === undefined
    ? 0.15
    : Number(__ENV.FOLLOWUP_PROBABILITY);
const ROUTE_P95_MS = Number(__ENV.ROUTE_P95_MS || 2000);
const ROUTE_P99_MS = Number(__ENV.ROUTE_P99_MS || 5000);
// `REQUEST_TIMEOUT` de apps/frontend/lib/data/client.ts.
const FRONTEND_TIMEOUT_MS = 8000;

if (!BASE_URL) throw new Error("Informe BASE_URL para a API.");
if (!Number.isFinite(RATE) || RATE < 1)
  throw new Error("RATE deve ser pelo menos 1 iteração/s.");
if (!Number.isInteger(INCIDENT_COUNT) || INCIDENT_COUNT < 1)
  throw new Error("INCIDENT_COUNT deve ser um inteiro positivo.");
if (!["synthetic", "discover"].includes(INCIDENT_IDS))
  throw new Error("INCIDENT_IDS deve ser synthetic ou discover.");
if (!["unavailable", "available", "either"].includes(MONITORING_EXPECTED))
  throw new Error("MONITORING_EXPECTED deve ser unavailable, available ou either.");
if (!(FOLLOWUP_PROBABILITY >= 0 && FOLLOWUP_PROBABILITY <= 1))
  throw new Error("FOLLOWUP_PROBABILITY deve estar entre 0 e 1.");

function secondsOf(duration) {
  const match = /^(\d+)(s|m|h)$/.exec(duration);
  if (!match)
    throw new Error(`DURATION inválida: ${duration} (use 90s, 30m ou 2h).`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
}

/* ---------- perfis de chegada ---------------------------------------------- */

// [nome da fase, duração em segundos, taxa-alvo]. O nome vira a tag `stage`
// das requisições, para o sumário mostrar latência por fase — sem isso, um
// `breakpoint` só devolve agregados e não diz em que taxa a API cedeu.
// Degraus do `breakpoint` (iterações/s). Cada degrau sobe em 10 s e segura 50 s na taxa-alvo:
// só um patamar estável mede o que a API sustenta nessa taxa (numa rampa linear a taxa média
// do trecho é a metade entre o degrau anterior e o atual). Depois do primeiro degrau que falha
// o serviço já está degradado (fila, task reiniciada), então leia só até ele.
const BREAKPOINT_STEPS = (__ENV.BREAKPOINT_STEPS || "10,20,30,40,50,75,100,150")
  .split(",")
  .map(Number);
if (BREAKPOINT_STEPS.some((step) => !Number.isFinite(step) || step < 1))
  throw new Error("BREAKPOINT_STEPS deve ser uma lista de taxas positivas, ex.: 10,20,30.");

const stagePlans = {
  load: [
    ["ramp_up", 30, RATE],
    ["plateau", 300, RATE],
    ["ramp_down", 15, 0],
  ],
  breakpoint: BREAKPOINT_STEPS.flatMap((target) => [
    [`r${target}`, 10, target],
    [`r${target}`, 50, target],
  ]),
  spike: [
    ["base", 60, RATE],
    ["ramp_up", 10, RATE * 4],
    ["peak", 30, RATE * 4],
    ["ramp_down", 10, RATE],
    ["recovery", 60, RATE],
  ],
  stress: [
    ["base", 60, RATE],
    ["ramp_up", 30, RATE * 2],
    ["plateau", 180, RATE * 2],
    ["ramp_down", 30, RATE],
    ["recovery", 60, RATE],
  ],
};

// Modelo aberto: se a API segura cada requisição até o timeout de 8 s, são necessários
// taxa x 8 VUs para continuar emitindo a carga pedida. Com menos, o k6 descarta chegadas
// (`dropped_iterations`) e a carga efetiva fica abaixo da pretendida justamente quando a API
// satura. O piso abaixo cobre isso; `MAX_VUS` sobrepõe (o gerador precisa de ~1 MB de RAM por VU).
function vusFor(peakRate, floor) {
  if (__ENV.MAX_VUS) return Number(__ENV.MAX_VUS);
  return Math.max(floor, Math.ceil(peakRate * (FRONTEND_TIMEOUT_MS / 1000) * 1.2));
}

function ramping(startRate, preAllocatedVUs, maxVUs, plan) {
  return {
    executor: "ramping-arrival-rate",
    startRate,
    timeUnit: "1s",
    preAllocatedVUs,
    maxVUs,
    stages: plan.map(([, seconds, target]) => ({
      duration: `${seconds}s`,
      target,
    })),
  };
}

const scenarioByMode = {
  smoke: {
    executor: "constant-arrival-rate",
    rate: 1,
    timeUnit: "1s",
    duration: "30s",
    preAllocatedVUs: 2,
    maxVUs: 10,
  },
  load: ramping(1, 100, vusFor(RATE, 500), stagePlans.load),
  breakpoint: ramping(1, 100, vusFor(Math.max(...BREAKPOINT_STEPS), 700), stagePlans.breakpoint),
  spike: ramping(RATE, 150, vusFor(RATE * 4, 1000), stagePlans.spike),
  stress: ramping(RATE, 150, vusFor(RATE * 2, 1200), stagePlans.stress),
  soak: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: 150,
    maxVUs: vusFor(RATE, 800),
  },
};
if (!scenarioByMode[MODE])
  throw new Error(
    `MODE inválido: ${MODE}. Use ${Object.keys(scenarioByMode).join(", ")}.`,
  );

// Fronteiras das fases (em s desde o início do cenário) e rótulos da tag.
const SOAK_BLOCKS = 12;
const soakBlockSeconds =
  MODE === "soak"
    ? Math.max(300, Math.ceil(secondsOf(DURATION) / SOAK_BLOCKS / 60) * 60)
    : 0;
const stageBounds = [];
if (stagePlans[MODE]) {
  let end = 0;
  stagePlans[MODE].forEach(([name, seconds], index) => {
    end += seconds;
    // No breakpoint a rampa e o patamar de um degrau dividem o mesmo rótulo (`r<taxa>`).
    const label = MODE === "breakpoint" ? name : `s${index + 1}_${name}`;
    stageBounds.push({ label, endSeconds: end });
  });
} else if (MODE === "soak") {
  const blocks = Math.ceil(secondsOf(DURATION) / soakBlockSeconds);
  for (let index = 0; index < blocks; index += 1)
    stageBounds.push({
      label: `t${String(index).padStart(2, "0")}`,
      endSeconds: (index + 1) * soakBlockSeconds,
    });
} else {
  stageBounds.push({ label: "steady", endSeconds: Infinity });
}
const stageLabels = [...new Set(stageBounds.map((bound) => bound.label))];

function currentStage() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const bound of stageBounds) if (elapsed < bound.endSeconds) return bound.label;
  return stageBounds[stageBounds.length - 1].label;
}

function ratesOfMode() {
  if (MODE === "smoke") return { base: 1, peak: 1 };
  if (stagePlans[MODE]) {
    const targets = stagePlans[MODE].map(([, , target]) => target);
    return { base: scenarioByMode[MODE].startRate, peak: Math.max(...targets) };
  }
  return { base: RATE, peak: RATE };
}

/* ---------- métricas ------------------------------------------------------- */

const routeSuccess = new Rate("front_api_contract_success_rate");
const routeFailed = new Rate("front_api_contract_failed_rate");
const rateLimited = new Counter("front_api_rate_limited_total");
const rumRateLimited = new Counter("front_api_rum_rate_limited_total");
const unavailable = new Counter("front_api_data_unavailable_total");
const partial = new Counter("front_api_partial_total");
const staleSnapshot = new Counter("front_api_stale_snapshot_total");
const clientTimeout = new Counter("front_api_client_timeout_total");
const hasMoreWithoutCursor = new Counter("front_api_has_more_without_cursor_total");
const followUpPages = new Counter("front_api_followup_pages_total");

/* ---------- rotas: o mix de chamadas do painel ----------------------------- */

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// IDs descobertos no setup (INCIDENT_IDS=discover); preenchido a cada iteração.
let discoveredIds = [];

// Troca a janela das rotas que aceitam `all` (incidentes e eventos).
const win = (path) =>
  WINDOW_OVERRIDE
    ? path.replace(/window=(24h|6h|1h|30m)/, `window=${WINDOW_OVERRIDE}`)
    : path;

function incidentId() {
  if (INCIDENT_IDS === "discover")
    return discoveredIds[Math.floor(Math.random() * discoveredIds.length)];
  const ordinal = 1 + Math.floor(Math.random() * INCIDENT_COUNT);
  return `inc-${String(ordinal).padStart(6, "0")}`;
}

// A primeira variante é exatamente o que a tela de Incidentes envia
// (apps/frontend/app/(painel)/incidentes/incidents-resource.ts): só `window`.
function incidentsPath() {
  const choice = Math.random();
  if (choice < 0.4) return "/api/v1/incidents?window=24h";
  if (choice < 0.55) return "/api/v1/incidents?window=24h&limit=20&sort=recent";
  if (choice < 0.7) return "/api/v1/incidents?window=6h&limit=20&sort=priority";
  if (choice < 0.82) return "/api/v1/incidents?window=24h&limit=50&priority=P1";
  if (choice < 0.92)
    return "/api/v1/incidents?window=24h&limit=50&status=investigating";
  return "/api/v1/incidents?window=24h&limit=20&priority=P2&status=investigating";
}

function dashboardPath() {
  const choice = Math.random();
  if (choice < 0.5) return "/api/v1/dashboard/overview?window=24h";
  if (choice < 0.8) return "/api/v1/dashboard/overview?window=1h";
  return "/api/v1/dashboard/overview?window=30m&incidentLimit=5";
}

// Lista (limit=50) e agregado de volume (limit=1), como a tela de Eventos pede.
function globalEventsPath() {
  return Math.random() < 0.7
    ? "/api/v1/events?window=30m&limit=50&correlation=all"
    : "/api/v1/events?window=30m&limit=1&correlation=all";
}

const RUM_SAMPLES = [
  ["frontend_web_vitals_fcp_seconds", "seconds", 1.1],
  ["frontend_web_vitals_lcp_seconds", "seconds", 2.0],
  ["frontend_web_vitals_inp_ms", "milliseconds", 120],
  ["frontend_web_vitals_cls", "score", 0.02],
];

function rumBody() {
  const [name, unit, value] =
    RUM_SAMPLES[Math.floor(Math.random() * RUM_SAMPLES.length)];
  return JSON.stringify({
    schemaVersion: 1,
    name,
    value,
    unit,
    path: "/visao-geral",
    navigationType: "navigate",
    occurredAt: new Date().toISOString(),
    rating: "good",
  });
}

const monitoringStatuses =
  MONITORING_EXPECTED === "unavailable"
    ? [503]
    : MONITORING_EXPECTED === "available"
      ? [200]
      : [200, 503];

// `shape` confere o que o painel realmente lê de `data` em cada rota.
const routes = [
  {
    tag: "incidents_list",
    weight: 24,
    statuses: [200],
    request: () => ({ path: win(incidentsPath()) }),
    shape: (data) => Array.isArray(data.items) && isObject(data.page),
  },
  {
    tag: "incidents_chart",
    weight: 8,
    statuses: [200],
    request: () => ({
      path: win("/api/v1/incidents?window=1h&chartMetric=affected_devices"),
    }),
    shape: (data) =>
      isObject(data.impactSeries) && Array.isArray(data.impactSeries.points),
  },
  {
    tag: "dashboard_overview",
    weight: 16,
    statuses: [200],
    request: () => ({ path: dashboardPath() }),
    shape: (data) =>
      Array.isArray(data.kpis) &&
      data.kpis.length > 0 &&
      isObject(data.experienceHealth) &&
      Array.isArray(data.recentIncidents),
  },
  {
    tag: "incident_diagnosis",
    weight: 16,
    statuses: [200],
    request: () => {
      const id = incidentId();
      return {
        path: `/api/v1/incidents/${encodeURIComponent(id)}/diagnosis`,
        incidentId: id,
      };
    },
    shape: (data, target) =>
      isObject(data.incident) &&
      data.incident.id === target.incidentId &&
      isObject(data.diagnosis) &&
      Array.isArray(data.evidence),
  },
  {
    tag: "incident_events",
    weight: 10,
    statuses: [200],
    request: () => ({
      path: win(
        `/api/v1/incidents/${encodeURIComponent(incidentId())}/events?window=30m&limit=50`,
      ),
    }),
    shape: (data) => Array.isArray(data.items) && isObject(data.page),
  },
  {
    tag: "global_events",
    weight: 10,
    statuses: [200],
    request: () => ({ path: win(globalEventsPath()) }),
    shape: (data) => Array.isArray(data.items) && isObject(data.page),
  },
  {
    tag: "monitoring_overview",
    weight: 7,
    statuses: monitoringStatuses,
    request: () => ({
      path: "/api/v1/monitoring/overview?window=15m&flowMetric=processing_latency",
    }),
    shape: (data) => isObject(data),
  },
  {
    tag: "auth_session",
    weight: 4,
    statuses: [200],
    request: () => ({ path: "/auth/session" }),
    shape: (data) => data.authenticated === true,
  },
  {
    tag: "argus_integration",
    weight: 1,
    statuses: [200],
    request: () => ({ path: "/api/v1/integrations/argus" }),
    shape: (data) => typeof data.enabled === "boolean",
  },
  {
    // Beacon de Web Vitals/erros que o painel dispara a cada visita; é a única
    // escrita do frontend em regime normal. O limiter próprio (600/min/IP)
    // responde 429 sem afetar o usuário (telemetria nunca interrompe o fluxo).
    tag: "rum_beacon",
    weight: 4,
    method: "POST",
    statuses: [202, 429],
    request: () => ({ path: "/api/v1/telemetry/rum", body: rumBody() }),
  },
];
const FOLLOWUP_TAG = "global_events_page_2";
const reportedTags = [...routes.map((route) => route.tag), FOLLOWUP_TAG];
const totalWeight = routes.reduce((sum, route) => sum + route.weight, 0);

function chooseRoute() {
  let value = Math.random() * totalWeight;
  for (const route of routes) {
    value -= route.weight;
    if (value < 0) return route;
  }
  return routes[0];
}

/* ---------- opções e thresholds -------------------------------------------- */

const smoke = MODE === "smoke";
// Carga sustentada (`load`, `soak`) mede disponibilidade: RNF09 pede 99,9%, o
// mesmo 0,1% que `consultas.js` já usava. `stress`, `spike` e `breakpoint`
// empurram a API além do regime normal de propósito e toleram até 2%.
const sustained = MODE === "load" || MODE === "soak";
const maxFailureRate = smoke ? "rate==0" : sustained ? "rate<0.001" : "rate<0.02";
const minSuccessRate = smoke ? "rate==1" : sustained ? "rate>0.999" : "rate>0.98";
const thresholds = {
  checks: [minSuccessRate],
  "http_req_duration{status:200}": ["p(95)<2000", "p(99)<5000"],
  http_req_failed: [maxFailureRate],
  front_api_contract_success_rate: [minSuccessRate],
  front_api_rate_limited_total: ["count==0"],
  front_api_client_timeout_total: ["count==0"],
  dropped_iterations: ["count==0"],
};
// Um threshold por rota: sem eles, uma rota pequena (ex.: 4% do tráfego) pode
// estar 100% quebrada ou lenta sem mexer no p95/taxa globais. Os de contagem
// (`>=0`, sempre verdadeiros) só existem para o k6 materializar a submétrica
// que o sumário imprime.
for (const tag of reportedTags) {
  thresholds[`http_req_duration{rota:${tag}}`] = [
    `p(95)<${ROUTE_P95_MS}`,
    `p(99)<${ROUTE_P99_MS}`,
  ];
  // Por rota o teto é 2% (1 falha em 160 requisições da rota de 1% já seria
  // 0,6%): o objetivo aqui é pegar rota inteira quebrada, que o global dilui.
  const perRoute = smoke ? "rate==0" : "rate<0.02";
  thresholds[`http_req_failed{rota:${tag}}`] = [perRoute];
  thresholds[`front_api_contract_failed_rate{rota:${tag}}`] = [perRoute];
  thresholds[`http_reqs{rota:${tag}}`] = ["count>=0"];
  thresholds[`front_api_partial_total{rota:${tag}}`] = ["count>=0"];
  thresholds[`front_api_data_unavailable_total{rota:${tag}}`] = ["count>=0"];
}
// Histograma de status para o sumário (0 = timeout ou erro de rede): mostra,
// por exemplo, 504 do gateway numa rajada, que o agregado de latência esconde.
const STATUS_CODES = [0, 200, 202, 401, 404, 429, 500, 502, 503, 504];
for (const code of STATUS_CODES)
  thresholds[`http_reqs{status:${code}}`] = ["count>=0"];
for (const label of stageLabels) {
  thresholds[`http_req_duration{stage:${label}}`] = ["max>=0"];
  thresholds[`http_req_failed{stage:${label}}`] = ["rate>=0"];
  thresholds[`http_reqs{stage:${label}}`] = ["count>=0"];
}

export const options = {
  scenarios: { frontend: scenarioByMode[MODE] },
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds,
};

/* ---------- setup ---------------------------------------------------------- */

function preflight(cookie, ids) {
  const params = {
    headers: { Cookie: `session=${cookie}`, Accept: "application/json" },
    tags: { rota: "preflight" },
    timeout: "10s",
  };
  const problems = [];
  const discover = INCIDENT_IDS === "discover";
  const window = discover ? "all" : "24h";
  const list = http.get(`${BASE_URL}/api/v1/incidents?window=${window}&limit=1`, params);
  const items = list.status === 200 ? (parseBody(list)?.data?.items ?? []) : null;
  if (!Array.isArray(items) || items.length === 0)
    problems.push(
      `GET /api/v1/incidents?window=${window} devolveu ${list.status === 200 ? "lista vazia" : `status ${list.status}`}` +
        (discover ? ": a API não tem incidentes" : ": seed ausente/envelhecido? (semeie imediatamente antes de cada rodada)"),
    );
  const probe = discover
    ? ids.slice(0, 1)
    : [...new Set([1, INCIDENT_COUNT])].map((n) => `inc-${String(n).padStart(6, "0")}`);
  for (const id of probe) {
    const response = http.get(`${BASE_URL}/api/v1/incidents/${id}/diagnosis`, params);
    if (response.status !== 200)
      problems.push(
        `o incidente ${id} não existe nesta API (diagnosis=${response.status}); ` +
          (discover
            ? "a descoberta devolveu um ID sem diagnóstico"
            : `o script sorteia inc-000001..inc-${String(INCIDENT_COUNT).padStart(6, "0")} — ajuste INCIDENT_COUNT, semeie a massa sintética ou use INCIDENT_IDS=discover`),
      );
  }
  if (problems.length)
    throw new Error(
      `Pré-checagem falhou (PREFLIGHT=0 desliga):\n - ${problems.join("\n - ")}`,
    );
}

function discoverIncidentIds(cookie) {
  const response = http.get(`${BASE_URL}/api/v1/incidents?window=all&limit=100`, {
    headers: { Cookie: `session=${cookie}`, Accept: "application/json" },
    tags: { rota: "preflight" },
    timeout: "10s",
  });
  const items = response.status === 200 ? (parseBody(response)?.data?.items ?? []) : [];
  const ids = items.map((item) => item.id).filter((id) => typeof id === "string");
  if (ids.length === 0)
    throw new Error(
      `INCIDENT_IDS=discover: GET /api/v1/incidents?window=all devolveu ${response.status === 200 ? "nenhum incidente" : `status ${response.status}`}.`,
    );
  return ids;
}

export function setup() {
  const health = http.get(`${BASE_URL}/health`, { tags: { rota: "health" } });
  if (health.status !== 200)
    throw new Error(
      `API indisponível em ${BASE_URL} (health=${health.status}).`,
    );
  const cookie =
    AUTH_USERNAME && AUTH_PASSWORD
      ? loginSessionCookie(BASE_URL, AUTH_USERNAME, AUTH_PASSWORD)
      : forgeSessionCookie({ role: "engineer" });
  const incidentIds = INCIDENT_IDS === "discover" ? discoverIncidentIds(cookie) : [];
  if (PREFLIGHT) preflight(cookie, incidentIds);
  return { cookie, incidentIds };
}

/* ---------- iteração ------------------------------------------------------- */

function errorCodeOf(response) {
  try {
    return response.json("error.code");
  } catch {
    return undefined;
  }
}

function send(route, target, cookie, rota, statuses) {
  const { params, requestId } = authParamsWithRequestId(
    cookie,
    {
      rota,
      name: `${route.method || "GET"} ${rota}`,
      stage: currentStage(),
    },
    `k6-front-${MODE}`,
  );
  const response = http.request(
    route.method || "GET",
    `${BASE_URL}${target.path}`,
    target.body === undefined ? null : target.body,
    {
      ...params,
      timeout: `${FRONTEND_TIMEOUT_MS}ms`,
      responseCallback: http.expectedStatuses(...statuses),
    },
  );
  return { response, requestId };
}

// Registra as métricas de saúde da resposta (não de conteúdo) de qualquer rota.
function recordTransport(response, rota) {
  if (response.status === 0)
    clientTimeout.add(1, { rota, error_code: String(response.error_code) });
  if (response.status === 429 && rota !== "rum_beacon")
    rateLimited.add(1, { rota });
  if (response.status === 429 && rota === "rum_beacon")
    rumRateLimited.add(1, { rota });
  if (response.status === 503) unavailable.add(1, { rota });
}

export default function (data) {
  discoveredIds = data.incidentIds || [];
  const route = chooseRoute();
  const target = route.request();
  const { response, requestId } = send(route, target, data.cookie, route.tag, route.statuses);
  recordTransport(response, route.tag);

  const rota = route.tag;
  let contractOk = false;
  let body = null;
  if (route.tag === "rum_beacon") {
    // 202 = aceito; 429 = limiter próprio, que o painel ignora.
    contractOk = response.status === 202 || response.status === 429;
  } else if (response.status === 200) {
    body = parseBody(response);
    contractOk =
      route.statuses.includes(200) &&
      body !== null &&
      isObject(body.data) &&
      route.shape(body.data, target);
  } else if (response.status === 503 && route.tag === "monitoring_overview") {
    contractOk =
      route.statuses.includes(503) &&
      errorCodeOf(response) === "DATA_UNAVAILABLE";
  }
  routeSuccess.add(contractOk, { rota });
  routeFailed.add(!contractOk, { rota });

  check(response, { [`${rota}: resposta de contrato`]: () => contractOk });
  checkRequestIdEcho(response, requestId, rota);
  if (response.status !== 200) return;

  checkNoPhysicalFields(response, rota);
  checkGatewayEnvelope(response, rota, body);
  if (!body || !body.meta) return;

  if (body.meta.partial) partial.add(1, { rota });
  const warnings = Array.isArray(body.meta.warnings) ? body.meta.warnings : [];
  const freshness = Array.isArray(body.meta.freshness) ? body.meta.freshness : [];
  if (
    warnings.some(
      (w) => w.code === "STALE_SNAPSHOT" || w.code === "ACTIVE_SNAPSHOT_OUTSIDE_WINDOW",
    ) ||
    freshness.some((f) => f.state === "delayed" || f.state === "unavailable")
  )
    staleSnapshot.add(1);

  if (rota === "incidents_list" || rota === "incidents_chart") {
    checkIncidentsSchema(response, rota);
    // A API declara `hasMore` mas nunca devolve cursor para incidentes: a
    // "rolagem infinita" não existe nessa tela, e este contador expõe o desvio.
    const page = body.data.page;
    if (rota === "incidents_list" && isObject(page) && page.hasMore === true && !page.nextCursor)
      hasMoreWithoutCursor.add(1);
  }

  // Tela de Eventos: "carregar mais" com o cursor da primeira página.
  // Só a variante de lista (limit=50): o agregado de volume (limit=1) não tem
  // "carregar mais" na tela.
  if (
    rota === "global_events" &&
    target.path.includes("limit=50") &&
    Math.random() < FOLLOWUP_PROBABILITY
  ) {
    const cursor = body.data.page && body.data.page.nextCursor;
    if (typeof cursor === "string" && cursor.length > 0)
      followUp(data.cookie, target.path, cursor, body.data.items);
  }
}

function followUp(cookie, path, cursor, firstItems) {
  const { response, requestId } = send(
    { method: "GET" },
    { path: `${path}&cursor=${encodeURIComponent(cursor)}` },
    cookie,
    FOLLOWUP_TAG,
    [200],
  );
  recordTransport(response, FOLLOWUP_TAG);
  followUpPages.add(1);
  const body = response.status === 200 ? parseBody(response) : null;
  const ok =
    body !== null &&
    isObject(body.data) &&
    Array.isArray(body.data.items) &&
    isObject(body.data.page);
  routeSuccess.add(ok, { rota: FOLLOWUP_TAG });
  routeFailed.add(!ok, { rota: FOLLOWUP_TAG });
  check(response, { [`${FOLLOWUP_TAG}: resposta de contrato`]: () => ok });
  checkRequestIdEcho(response, requestId, FOLLOWUP_TAG);
  if (response.status !== 200) return;
  checkNoPhysicalFields(response, FOLLOWUP_TAG);
  checkGatewayEnvelope(response, FOLLOWUP_TAG, body);
  if (ok) checkNoDuplicateIds(firstItems, body.data.items, FOLLOWUP_TAG);
}

/* ---------- sumário -------------------------------------------------------- */

const value = (data, name, key) => {
  const metric = data.metrics[name];
  return metric && metric.values ? metric.values[key] : undefined;
};
const fixed = (number, digits = 0) =>
  number === undefined || Number.isNaN(number) ? "-" : number.toFixed(digits);

function renderSummary(data, output) {
  const lines = [];
  const { base, peak } = ratesOfMode();
  const iterations = value(data, "iterations", "count") || 0;
  const requests = value(data, "http_reqs", "count") || 0;
  const dropped = value(data, "dropped_iterations", "count") || 0;
  lines.push(`Carga da API consumida pelo frontend — modo ${MODE}`);
  if (iterations === 0) {
    lines.push(
      "Nenhuma iteração foi executada: o setup() abortou (saúde, login ou pré-checagem). " +
        "Veja o erro acima; os thresholds não se aplicam.",
    );
    return lines.join("\n") + "\n";
  }
  lines.push(
    `Taxa de chegada (iterações/s): base ${base}, pico ${peak}; ` +
      `${iterations} iterações, ${requests} requisições, ` +
      `${fixed(value(data, "iterations", "rate"), 1)} iter/s médios`,
  );
  lines.push(
    `429 (limite de taxa do gerador): ${value(data, "front_api_rate_limited_total", "count") || 0}; ` +
      `503: ${value(data, "front_api_data_unavailable_total", "count") || 0}; ` +
      `timeouts do cliente (>${FRONTEND_TIMEOUT_MS} ms): ${value(data, "front_api_client_timeout_total", "count") || 0}; ` +
      `iterações descartadas: ${dropped}`,
  );

  const statuses = STATUS_CODES.map((code) => [
    code,
    value(data, `http_reqs{status:${code}}`, "count") || 0,
  ])
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${code}=${count}`);
  lines.push(`Status HTTP (0 = timeout/erro de rede): ${statuses.join("  ")}`);

  const failing = [];
  let passing = 0;
  for (const [name, metric] of Object.entries(data.metrics))
    for (const [expression, result] of Object.entries(metric.thresholds || {}))
      if (result.ok) passing += 1;
      else failing.push(`${name} ${expression}`);
  lines.push("");
  lines.push(
    failing.length
      ? `THRESHOLDS: ${failing.length} reprovados, ${passing} aprovados`
      : `THRESHOLDS: todos os ${passing} aprovados`,
  );
  for (const item of failing.slice(0, 12)) lines.push(`  ✗ ${item}`);
  if (failing.length > 12)
    lines.push(`  … e mais ${failing.length - 12} (lista completa no JSON)`);

  lines.push("");
  lines.push("Por rota            req   falha%  contrato%   p50ms   p95ms   p99ms  parcial%");
  for (const tag of reportedTags) {
    const count = value(data, `http_reqs{rota:${tag}}`, "count") || 0;
    if (count === 0) continue;
    const failed = value(data, `http_req_failed{rota:${tag}}`, "rate") || 0;
    const contractFailed =
      value(data, `front_api_contract_failed_rate{rota:${tag}}`, "rate") || 0;
    const partialCount = value(data, `front_api_partial_total{rota:${tag}}`, "count") || 0;
    const key = `http_req_duration{rota:${tag}}`;
    lines.push(
      `${tag.padEnd(19)} ${String(count).padStart(6)} ${fixed(failed * 100, 2).padStart(7)} ` +
        `${fixed((1 - contractFailed) * 100, 2).padStart(10)} ` +
        `${fixed(value(data, key, "med")).padStart(7)} ${fixed(value(data, key, "p(95)")).padStart(7)} ` +
        `${fixed(value(data, key, "p(99)")).padStart(7)} ${fixed((partialCount / count) * 100, 1).padStart(9)}`,
    );
  }

  if (stageLabels.length > 1) {
    lines.push("");
    lines.push("Por fase            req   falha%   p50ms   p95ms   p99ms");
    for (const label of stageLabels) {
      const count = value(data, `http_reqs{stage:${label}}`, "count") || 0;
      const key = `http_req_duration{stage:${label}}`;
      lines.push(
        `${label.padEnd(19)} ${String(count).padStart(6)} ` +
          `${fixed((value(data, `http_req_failed{stage:${label}}`, "rate") || 0) * 100, 2).padStart(7)} ` +
          `${fixed(value(data, key, "med")).padStart(7)} ${fixed(value(data, key, "p(95)")).padStart(7)} ` +
          `${fixed(value(data, key, "p(99)")).padStart(7)}`,
      );
    }
  }

  const notes = [];
  for (const tag of reportedTags) {
    const count = value(data, `http_reqs{rota:${tag}}`, "count") || 0;
    const missing = value(data, `front_api_data_unavailable_total{rota:${tag}}`, "count") || 0;
    if (count > 0 && missing > 0)
      notes.push(
        `${tag}: ${missing}/${count} respostas 503 DATA_UNAVAILABLE` +
          (missing === count ? " — a rota não está sendo exercitada (sem projeção)" : ""),
      );
  }
  if (dropped > 0) {
    const wanted = iterations + dropped;
    notes.push(
      `${dropped} de ${wanted} chegadas (${fixed((dropped / wanted) * 100, 1)}%) não foram emitidas: ` +
        `os VUs esgotaram (latência alta segura cada VU) e a carga efetiva ficou abaixo da pretendida; ` +
        `se o gerador não está saturado, aumente MAX_VUS`,
    );
  }
  const noCursor = value(data, "front_api_has_more_without_cursor_total", "count") || 0;
  if (noCursor > 0)
    notes.push(
      `incidents_list: ${noCursor} respostas com hasMore=true e nextCursor=null — a API não pagina incidentes`,
    );
  const followUps = value(data, "front_api_followup_pages_total", "count") || 0;
  if (MODE !== "smoke" && FOLLOWUP_PROBABILITY > 0 && followUps === 0)
    notes.push("paginação de eventos por cursor não foi exercitada (nenhuma segunda página disponível)");
  const stale = value(data, "front_api_stale_snapshot_total", "count") || 0;
  if (stale > 0)
    notes.push(`${stale} respostas 200 com snapshot desatualizado (STALE_SNAPSHOT/delayed)`);
  const rum429 = value(data, "front_api_rum_rate_limited_total", "count") || 0;
  if (rum429 > 0) notes.push(`${rum429} beacons RUM recusados com 429 (limiter próprio de 600/min)`);
  if (notes.length) {
    lines.push("");
    lines.push("Observações:");
    for (const note of notes) lines.push(`  - ${note}`);
  }
  lines.push("");
  lines.push(`Resumo detalhado: ${output}`);
  return lines.join("\n") + "\n";
}

export function handleSummary(data) {
  const output = `${RESULTS_DIR}/resumo-front-api-${MODE}.json`;
  const safeData = {
    ...data,
    setup_data: data.setup_data
      ? { ...data.setup_data, cookie: "<redigido: cookie de sessão>" }
      : data.setup_data,
  };
  return {
    stdout: renderSummary(data, output),
    [output]: JSON.stringify(safeData, null, 2),
  };
}

/**
 * Carga mista nas rotas de leitura consumidas pelo frontend View Show.
 * Não chama ingestão, LLM, login Cognito nem operações que alterem dados.
 * A sessão é preparada uma vez no setup, e cada requisição leva um request id.
 */
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import {
  authParamsWithRequestId,
  forgeSessionCookie,
  loginSessionCookie,
} from "./lib/session.js";
import {
  checkIncidentsSchema,
  checkNoPhysicalFields,
  checkRequestIdEcho,
} from "./lib/asserts.js";

const BASE_URL = (__ENV.BASE_URL || "").replace(/\/$/, "");
const MODE = __ENV.MODE || "smoke";
const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || "30m";
const INCIDENT_COUNT = Number(__ENV.INCIDENT_COUNT || 300);
const AUTH_USERNAME = __ENV.AUTH_USERNAME;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD;
const RESULTS_DIR = (__ENV.RESULTS_DIR || ".").replace(/\/$/, "");

if (!BASE_URL) throw new Error("Informe BASE_URL para a API.");
if (!Number.isFinite(RATE) || RATE < 1)
  throw new Error("RATE deve ser pelo menos 1 req/s.");
if (!Number.isInteger(INCIDENT_COUNT) || INCIDENT_COUNT < 1)
  throw new Error("INCIDENT_COUNT deve ser um inteiro positivo.");

// O monitoramento ainda responde 503 DATA_UNAVAILABLE por contrato enquanto
// a projeção pública correspondente não existe na versão ativa do dataset.
http.setResponseCallback(http.expectedStatuses(200, 503));

const scenarioByMode = {
  smoke: {
    executor: "constant-arrival-rate",
    rate: 1,
    timeUnit: "1s",
    duration: "30s",
    preAllocatedVUs: 2,
    maxVUs: 10,
  },
  load: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 100,
    maxVUs: 500,
    stages: [
      { duration: "30s", target: RATE },
      { duration: "5m", target: RATE },
      { duration: "15s", target: 0 },
    ],
  },
  breakpoint: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 100,
    maxVUs: 700,
    stages: [10, 25, 50, 75, 100, 150].map((target) => ({
      duration: "1m",
      target,
    })),
  },
  spike: {
    executor: "ramping-arrival-rate",
    startRate: RATE,
    timeUnit: "1s",
    preAllocatedVUs: 150,
    maxVUs: 1000,
    stages: [
      { duration: "1m", target: RATE },
      { duration: "10s", target: RATE * 4 },
      { duration: "30s", target: RATE * 4 },
      { duration: "10s", target: RATE },
      { duration: "1m", target: RATE },
    ],
  },
  stress: {
    executor: "ramping-arrival-rate",
    startRate: RATE,
    timeUnit: "1s",
    preAllocatedVUs: 150,
    maxVUs: 1200,
    stages: [
      { duration: "1m", target: RATE },
      { duration: "30s", target: RATE * 2 },
      { duration: "3m", target: RATE * 2 },
      { duration: "30s", target: RATE },
      { duration: "1m", target: RATE },
    ],
  },
  soak: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: 150,
    maxVUs: 800,
  },
};
if (!scenarioByMode[MODE])
  throw new Error(
    `MODE inválido: ${MODE}. Use ${Object.keys(scenarioByMode).join(", ")}.`,
  );

const routeSuccess = new Rate("front_api_contract_success_rate");
const rateLimited = new Counter("front_api_rate_limited_total");
const unavailable = new Counter("front_api_data_unavailable_total");

export const options = {
  scenarios: { frontend: scenarioByMode[MODE] },
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    checks: [MODE === "smoke" ? "rate==1" : "rate>0.98"],
    "http_req_duration{status:200}": ["p(95)<2000", "p(99)<5000"],
    http_req_failed: [MODE === "smoke" ? "rate==0" : "rate<0.02"],
    front_api_contract_success_rate: [
      MODE === "smoke" ? "rate==1" : "rate>0.98",
    ],
    front_api_rate_limited_total: ["count==0"],
    dropped_iterations: ["count==0"],
  },
};

const paths = {
  authSession: { method: "GET", path: "/auth/session", tag: "auth_session" },
  dashboard: {
    method: "GET",
    path: "/api/v1/dashboard/overview?window=30m&incidentLimit=5",
    tag: "dashboard_overview",
  },
  incidents: {
    method: "GET",
    path: "/api/v1/incidents?window=24h&limit=20&sort=recent",
    tag: "incidents_list",
  },
  diagnosis: { method: "GET", path: null, tag: "incident_diagnosis" },
  incidentEvents: { method: "GET", path: null, tag: "incident_events" },
  globalEvents: {
    method: "GET",
    path: "/api/v1/events?window=30m&limit=50&correlation=all",
    tag: "global_events",
  },
  monitoring: {
    method: "GET",
    path: "/api/v1/monitoring/overview?window=15m&flowMetric=processing_latency",
    tag: "monitoring_overview",
  },
  integration: {
    method: "GET",
    path: "/api/v1/integrations/argus",
    tag: "argus_integration",
  },
};

// Mix de sessões de tela; incidents é mais acessada, seguida de overview,
// diagnóstico e eventos. Auth session representa verificações iniciais.
const weights = [
  ["incidents", 32],
  ["dashboard", 18],
  ["diagnosis", 16],
  ["incidentEvents", 12],
  ["globalEvents", 10],
  ["monitoring", 7],
  ["authSession", 4],
  ["integration", 1],
];
const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);

function incidentId() {
  const ordinal = 1 + Math.floor(Math.random() * INCIDENT_COUNT);
  return `inc-${String(ordinal).padStart(6, "0")}`;
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
  return { cookie };
}

function chooseRoute() {
  let value = Math.random() * totalWeight;
  for (const [route, weight] of weights) {
    value -= weight;
    if (value < 0) return route;
  }
  return "incidents";
}

function incidentsPath() {
  const choice = Math.random();
  if (choice < 0.55) return "/api/v1/incidents?window=24h&limit=20&sort=recent";
  if (choice < 0.7) return "/api/v1/incidents?window=6h&limit=20&sort=priority";
  if (choice < 0.82) return "/api/v1/incidents?window=24h&limit=50&priority=P1";
  if (choice < 0.92)
    return "/api/v1/incidents?window=24h&limit=50&status=investigating";
  return "/api/v1/incidents?window=24h&limit=20&priority=P2&status=investigating";
}

export default function (data) {
  const routeName = chooseRoute();
  const route = paths[routeName];
  const path =
    routeName === "incidents"
      ? incidentsPath()
      : routeName === "diagnosis" || routeName === "incidentEvents"
        ? `/api/v1/incidents/${encodeURIComponent(incidentId())}/${routeName === "diagnosis" ? "diagnosis" : "events"}`
        : route.path;
  const { params, requestId } = authParamsWithRequestId(
    data.cookie,
    {
      rota: route.tag,
      name: `${route.method} ${route.tag}`,
    },
    `k6-front-${MODE}`,
  );
  const response = http.request(
    route.method,
    `${BASE_URL}${path}`,
    null,
    params,
  );
  const monitoringUnavailable =
    routeName === "monitoring" && response.status === 503;
  const successful = response.status === 200 || monitoringUnavailable;
  routeSuccess.add(successful, { rota: route.tag });
  if (response.status === 429) rateLimited.add(1, { rota: route.tag });
  if (response.status === 503) unavailable.add(1, { rota: route.tag });
  if (response.status === 200) {
    checkNoPhysicalFields(response, route.tag);
    if (routeName === "incidents") checkIncidentsSchema(response, route.tag);
  }
  check(response, {
    [`${route.tag}: resposta de contrato`]: (r) => {
      if (monitoringUnavailable)
        return r.status === 503 && r.json("error.code") === "DATA_UNAVAILABLE";
      return r.status === 200;
    },
    [`${route.tag}: request id ecoado`]: (r) =>
      r.headers["X-Request-Id"] === requestId,
  });

  // Simula a rolagem infinita da tela de incidentes em uma fração do tráfego.
  if (
    routeName === "incidents" &&
    response.status === 200 &&
    Math.random() < 0.15
  ) {
    let cursor;
    let firstItems;
    try {
      cursor = response.json("data.page.nextCursor");
      firstItems = response.json("data.items");
    } catch {
      return;
    }
    if (typeof cursor === "string" && cursor.length > 0) {
      const page2 = authParamsWithRequestId(
        data.cookie,
        {
          rota: "incidents_page_2",
          name: "GET incidents cursor page 2",
        },
        `k6-front-${MODE}`,
      );
      const next = http.get(
        `${BASE_URL}${path}&cursor=${encodeURIComponent(cursor)}`,
        page2.params,
      );
      routeSuccess.add(next.status === 200, { rota: "incidents_page_2" });
      check(next, {
        "incidents_page_2: resposta 200": (r) => r.status === 200,
        "incidents_page_2: request id ecoado": (r) =>
          r.headers["X-Request-Id"] === page2.requestId,
      });
      if (next.status === 200) {
        checkIncidentsSchema(next, "incidents_page_2");
        checkNoPhysicalFields(next, "incidents_page_2");
        let secondItems = [];
        try {
          secondItems = next.json("data.items");
        } catch {
          /* schema check reports malformed body */
        }
        const firstIds = new Set(firstItems.map((item) => item.id));
        check(
          secondItems.every((item) => !firstIds.has(item.id)),
          {
            "incidents_page_2: sem duplicatas da primeira página": (ok) => ok,
          },
        );
      }
    }
  }
}

export function handleSummary(data) {
  const output = `${RESULTS_DIR}/resumo-front-api-${MODE}.json`;
  const safeData = {
    ...data,
    setup_data: data.setup_data
      ? { ...data.setup_data, cookie: "<redigido: cookie de sessão>" }
      : data.setup_data,
  };
  const limited = data.metrics.front_api_rate_limited_total?.values?.count || 0;
  const unavailableCount =
    data.metrics.front_api_data_unavailable_total?.values?.count || 0;
  const droppedCount = data.metrics.dropped_iterations?.values?.count || 0;
  return {
    stdout:
      [
        `Carga da API consumida pelo frontend — modo ${MODE}`,
        `Taxa configurada: ${RATE} req/s; rate limits: ${limited}; indisponibilidades: ${unavailableCount}; iterações descartadas: ${droppedCount}`,
        `Resumo detalhado: ${output}`,
      ].join("\n") + "\n",
    [output]: JSON.stringify(safeData, null, 2),
  };
}

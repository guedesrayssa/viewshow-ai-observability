/**
 * Teste de desempenho da API de consulta do View Show (branch feat/backend-2).
 *
 * Alvo: a API agêntica/de consulta em ECS Fargate (0,25 vCPU · 0,5 GB, conforme
 * apps/backend/api/deploy/task-definition.json). NÃO é a API de ingestão do
 * MVP da Sprint 1 — esta branch não expõe endpoint de ingestão.
 *
 * SLA: RNF14 — "o dashboard e as APIs de consulta devem retornar os resultados
 * de uma busca filtrada em até 2 segundos para 95% das solicitações (P95)".
 *
 * Carga: 137 req/s = pico de 4,1 M sessões simultâneas (entendimento_negocio.md)
 * dividido por 1.000. O fator de escala é declarado, não escondido.
 *
 * Modelo ABERTO (constant-arrival-rate): o painel de um SRE não espera a API
 * ficar rápida para o próximo operador abrir a tela. Modelo fechado (VU+sleep)
 * esconderia a saturação — a carga cairia sozinha quando a API degradasse.
 *
 * USO:
 *   k6 run -e BASE_URL=http://<host>:3000 -e MODE=smoke consultas.js
 *   k6 run -e BASE_URL=... -e MODE=load  --summary-export=resumo-load.json consultas.js
 */

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const MODE = __ENV.MODE || "smoke";
const RATE = Number(__ENV.RATE || 137);
const INCIDENT_COUNT = Number(__ENV.INCIDENT_COUNT || 300);

if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");

/** IDs são ordinais determinísticos gerados por seed-carga.js. */
function incidentId() {
  const n = 1 + Math.floor(Math.random() * INCIDENT_COUNT);
  return `inc-${String(n).padStart(6, "0")}`;
}

const latenciaLeve = new Trend("vs_leve_ms");
const latenciaPesada = new Trend("vs_pesada_ms");
const latenciaBundle = new Trend("vs_bundle_ms");

/* ------------------------------ cenários ------------------------------ */

const CENARIOS = {
  // 1. Confere que script e API funcionam antes de gastar carga.
  smoke: {
    executor: "constant-vus",
    vus: 1,
    duration: "30s",
  },

  // 2. A rodada do relatório: carga média sustentada, com aquecimento.
  load: {
    executor: "ramping-arrival-rate",
    startRate: 10,
    timeUnit: "1s",
    preAllocatedVUs: 100,
    maxVUs: 800,
    stages: [
      { duration: "30s", target: RATE }, // aquecimento
      { duration: "3m", target: RATE },  // platô
      { duration: "15s", target: 0 },
    ],
  },

  // 3. O joelho da curva.
  //    Rampa recalibrada APÓS o load: a 137 req/s a vazão útil foi de ~3,2/s
  //    com 91,9% de erro, e 800 VUs entregaram menos que 1 VU. O joelho está
  //    abaixo de 10 req/s, então a rampa original (10→1200) começaria já
  //    saturada e não mediria nada.
  breakpoint: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 20,
    maxVUs: 200,
    stages: [
      { duration: "45s", target: 2 },
      { duration: "45s", target: 4 },
      { duration: "45s", target: 6 },
      { duration: "45s", target: 9 },
      { duration: "45s", target: 13 },
      { duration: "45s", target: 20 },
    ],
  },

  // 4. Gol na Copa: salto brusco e curto.
  spike: {
    executor: "ramping-arrival-rate",
    startRate: RATE,
    timeUnit: "1s",
    preAllocatedVUs: 200,
    maxVUs: 2000,
    stages: [
      { duration: "1m", target: RATE },
      { duration: "10s", target: 1000 },
      { duration: "30s", target: 1000 },
      { duration: "10s", target: RATE },
      { duration: "1m", target: RATE },
    ],
  },

  // 5. Vazamento de memória e fila que enche devagar.
  soak: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: "2h",
    preAllocatedVUs: 200,
    maxVUs: 800,
  },

  // 6. Rodada ISOLADA e de baixa taxa: /diagnose ESCREVE no DynamoDB
  //    (orchestrator → saveHypothesis). Não misture com os cenários de leitura.
  diagnose: {
    executor: "constant-arrival-rate",
    rate: 5,
    timeUnit: "1s",
    duration: "1m",
    preAllocatedVUs: 20,
    maxVUs: 100,
    exec: "diagnosticar",
  },
};

if (!CENARIOS[MODE]) {
  throw new Error(`MODE inválido: ${MODE}. Use: ${Object.keys(CENARIOS).join(", ")}`);
}

export const options = {
  scenarios: { [MODE]: CENARIOS[MODE] },
  thresholds: {
    // RNF14 — a única linha com SLA de origem documentada.
    http_req_duration: ["p(95)<2000"],
    // RNF09 (disponibilidade 99,9%) traduzido para a janela do teste.
    http_req_failed: ["rate<0.01"],
    // Vazão mínima: o alvo declarado, com folga de 5%.
    ...(MODE === "load" ? { http_reqs: [`rate>${Math.floor(RATE * 0.95)}`] } : {}),
    checks: ["rate>0.99"],
  },
  // Sem isso o k6 agrega /incidents/inc-000001 e /incidents/inc-000002 como
  // URLs diferentes e o resumo vira ilegível.
  discardResponseBodies: false,
};

/* ------------------------------- setup -------------------------------- */

/** Login uma vez. O cookie é HMAC com maxAge de 8 h (src/auth/session.js),
 *  então não precisa renovar durante o teste. Só o PATCH de review exige
 *  sessão — e ele fica FORA da carga, porque promove caso à golden set. */
export function setup() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: __ENV.AUTH_EMAIL || "demo@globoplay.com",
      password: __ENV.AUTH_PASSWORD || "demo123",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (res.status !== 200) {
    throw new Error(`Login falhou: HTTP ${res.status}. A API está de pé em ${BASE_URL}?`);
  }
  return { cookie: res.cookies.session ? res.cookies.session[0].value : null };
}

/* ------------------------------ cenários ------------------------------ */

export default function () {
  const sorteio = Math.random();

  if (sorteio < 0.45) {
    // A — leitura PESADA: window=24h varre 25 buckets de hora em paralelo.
    //     É o pior caso real e o que a tela de incidentes usa.
    const res = http.get(`${BASE_URL}/api/v1/incidents?window=24h`, {
      tags: { cenario: "pesada", name: "GET /incidents?window=24h" },
    });
    latenciaPesada.add(res.timings.duration);
    check(res, {
      "pesada: 200": (r) => r.status === 200,
      "pesada: tem incidents": (r) => {
        try { return Array.isArray(r.json("incidents")); } catch { return false; }
      },
      "pesada: lista não vazia": (r) => {
        try { return r.json("incidents").length > 0; } catch { return false; }
      },
    });
  } else if (sorteio < 0.7) {
    // B — leitura LEVE: window=15m varre só 2 buckets.
    //     ⚠️ Só devolve dado se o seed rodou há menos de ~1 h.
    const res = http.get(`${BASE_URL}/api/v1/incidents?window=15m`, {
      tags: { cenario: "leve", name: "GET /incidents?window=15m" },
    });
    latenciaLeve.add(res.timings.duration);
    check(res, { "leve: 200": (r) => r.status === 200 });
  } else if (sorteio < 0.9) {
    // C — BUNDLE: Query única no GSI trace-index. Caminho da tela de evidências.
    //     Independe do relógio, então não sofre com o envelhecimento do seed.
    const id = incidentId();
    const res = http.get(`${BASE_URL}/api/v1/incidents/${id}/evidence`, {
      tags: { cenario: "bundle", name: "GET /incidents/:id/evidence" },
    });
    latenciaBundle.add(res.timings.duration);
    check(res, {
      "bundle: 200": (r) => r.status === 200,
      "bundle: tem evidence": (r) => {
        try { return Array.isArray(r.json("evidence")); } catch { return false; }
      },
    });
  } else {
    // D — SUMMARY: o que /visao-geral chama ao abrir.
    const res = http.get(`${BASE_URL}/api/v1/dashboard/summary`, {
      tags: { cenario: "summary", name: "GET /dashboard/summary" },
    });
    check(res, {
      "summary: 200": (r) => r.status === 200,
      "summary: tem stats": (r) => {
        try { return Array.isArray(r.json("stats")); } catch { return false; }
      },
    });
  }
}

/** Cenário isolado — ESCREVE no banco a cada chamada. */
export function diagnosticar() {
  const id = incidentId();
  const res = http.post(`${BASE_URL}/api/v1/incidents/${id}/diagnose`, null, {
    tags: { cenario: "diagnose", name: "POST /incidents/:id/diagnose" },
  });
  check(res, {
    "diagnose: 200": (r) => r.status === 200,
    "diagnose: tem hypothesis": (r) => {
      try { return typeof r.json("hypothesis") === "string"; } catch { return false; }
    },
  });
}

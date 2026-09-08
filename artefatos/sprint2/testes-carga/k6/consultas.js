/**
 * Teste de desempenho da API de consulta do View Show.
 *
 * Alvo: a API agêntica/de consulta em ECS Fargate (0,25 vCPU · 0,5 GB, conforme
 * apps/backend/api/deploy/task-definition.json). NÃO é a API de ingestão do
 * MVP da Sprint 1 — esta API não expõe endpoint de ingestão.
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
 * ESTADO DO SCHEMA: apps/backend/api/src/db/keys.js já gera sk com prefixo
 * próprio para evidência/hipótese (EVIDENCE#/HYPOTHESIS#, não mais
 * INCIDENT#...#EVIDENCE#...) — a correção do defeito medido em
 * testes-desempenho.md §8 está aplicada no código. Os números de capacidade
 * daquele relatório (~4 req/s) descrevem o estado ANTERIOR à correção; esta
 * rodada deve produzir um novo baseline, não reproduzir o antigo.
 *
 * Este arquivo só simula tráfego (requisições, checks, thresholds nativos do
 * k6). Coleta de métricas de servidor (CPU, RCU, logs) é responsabilidade da
 * pilha de observabilidade local (docker-compose.observability.yml — Grafana
 * LGTM), não deste script.
 *
 * Verificação de controle de acesso (RNF04): script separado, auth-check.js —
 * não é objetivo de desempenho, então não compartilha cenário com este.
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
const STRESS_MULTIPLIER = Number(__ENV.STRESS_MULTIPLIER || 3);
const INCIDENT_COUNT = Number(__ENV.INCIDENT_COUNT || 300);

if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");
if (!Number.isFinite(RATE) || RATE <= 0) throw new Error("RATE deve ser um número positivo");
if (!Number.isFinite(STRESS_MULTIPLIER) || STRESS_MULTIPLIER <= 1) {
  throw new Error("STRESS_MULTIPLIER deve ser um número maior que 1");
}
if (!Number.isInteger(INCIDENT_COUNT) || INCIDENT_COUNT <= 0) {
  throw new Error("INCIDENT_COUNT deve ser um inteiro positivo");
}

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
  //    A rampa anterior (1→20 req/s) foi calibrada para o sistema COM o
  //    defeito de chave: o joelho ficava abaixo de 10 req/s, e uma rampa até
  //    1200 já começaria saturada. Com a correção aplicada (src/db/keys.js),
  //    esse teto não vale mais e o joelho real é desconhecido de novo — a
  //    faixa abaixo foi alargada até um pouco acima do alvo de negócio
  //    (137 req/s) para redescobri-lo, sem herdar a suposição do baseline
  //    antigo.
  breakpoint: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 30,
    maxVUs: 300,
    stages: [
      { duration: "45s", target: 5 },
      { duration: "45s", target: 10 },
      { duration: "45s", target: 20 },
      { duration: "45s", target: 40 },
      { duration: "45s", target: 70 },
      { duration: "45s", target: 110 },
      { duration: "45s", target: 160 },
      { duration: "45s", target: 220 },
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

  // 4b. Estresse: diferente do spike (rajada breve de 30s) e do breakpoint
  //     (degraus curtos para achar o joelho), aqui a carga fica SUSTENTADA
  //     bem acima da capacidade por minutos — a pergunta não é "onde
  //     satura", é "como se comporta enquanto satura, e se recupera limpo
  //     quando a carga cai". Observar principalmente: taxa/tipo de erro
  //     (5xx vs. timeout vs. conexão recusada) e se o p95 volta ao normal
  //     no trecho final, ou se sobra efeito residual (fila que não drena).
  estresse: {
    executor: "ramping-arrival-rate",
    startRate: RATE,
    timeUnit: "1s",
    preAllocatedVUs: 200,
    maxVUs: 1500,
    stages: [
      { duration: "30s", target: RATE },                    // baseline
      { duration: "30s", target: RATE * STRESS_MULTIPLIER }, // sobe além da capacidade
      { duration: "3m", target: RATE * STRESS_MULTIPLIER },  // sustenta (não é rajada)
      { duration: "30s", target: RATE },                     // volta ao alvo de negócio
      { duration: "1m", target: RATE },                      // janela de recuperação
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
    // Breakpoint, spike e estresse procuram degradação deliberadamente. Seus
    // checks continuam no relatório, mas não reprovam a execução pelo SLA de
    // operação normal. Load/soak validam RNF14 e RNF09.
    ...(["load", "soak"].includes(MODE)
      ? {
          http_req_duration: ["p(95)<2000"],
          http_req_failed: ["rate<0.01"],
          checks: ["rate>0.99"],
        }
      : {}),
    ...(MODE === "smoke" ? { http_req_failed: ["rate<0.01"], checks: ["rate==1"] } : {}),
    // Vazão mínima: o alvo declarado, com folga de 5%.
    ...(MODE === "load" ? { http_reqs: [`rate>${Math.floor(RATE * 0.95)}`] } : {}),
    ...(MODE === "diagnose" ? { http_req_failed: ["rate<0.01"], checks: ["rate>0.99"] } : {}),
  },
  // Sem isso o k6 agrega /incidents/inc-000001 e /incidents/inc-000002 como
  // URLs diferentes e o resumo vira ilegível.
  discardResponseBodies: false,
};

/* ------------------------------- setup -------------------------------- */

/** Login uma vez. O cookie é enviado em todas as chamadas, inclusive enquanto
 *  algumas rotas ainda são públicas, para que a suíte continue válida quando
 *  o RNF04 for aplicado a todas as APIs de consulta. */
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
  const cookie = res.cookies.session ? res.cookies.session[0].value : null;
  if (!cookie) throw new Error("Login OK mas nenhum cookie 'session' voltou.");
  return { cookie };
}

function requestParams(data, tags) {
  return {
    headers: { Cookie: `session=${data.cookie}` },
    tags,
  };
}

/* ------------------------------ cenários ------------------------------ */

export default function (data) {
  const sorteio = Math.random();

  if (sorteio < 0.45) {
    // A — leitura PESADA: window=24h varre 25 buckets de hora em paralelo.
    //     É o pior caso real e o que a tela de incidentes usa.
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=24h`,
      requestParams(data, { cenario: "pesada", name: "GET /incidents?window=24h" }),
    );
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
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=15m`,
      requestParams(data, { cenario: "leve", name: "GET /incidents?window=15m" }),
    );
    latenciaLeve.add(res.timings.duration);
    check(res, { "leve: 200": (r) => r.status === 200 });
  } else if (sorteio < 0.9) {
    // C — BUNDLE: Query única no GSI trace-index. Caminho da tela de evidências.
    //     Independe do relógio, então não sofre com o envelhecimento do seed.
    const id = incidentId();
    const res = http.get(
      `${BASE_URL}/api/v1/incidents/${id}/evidence`,
      requestParams(data, { cenario: "bundle", name: "GET /incidents/:id/evidence" }),
    );
    latenciaBundle.add(res.timings.duration);
    check(res, {
      "bundle: 200": (r) => r.status === 200,
      "bundle: tem evidence": (r) => {
        try { return Array.isArray(r.json("evidence")); } catch { return false; }
      },
    });
  } else {
    // D — SUMMARY: o que /visao-geral chama ao abrir.
    const res = http.get(
      `${BASE_URL}/api/v1/dashboard/summary`,
      requestParams(data, { cenario: "summary", name: "GET /dashboard/summary" }),
    );
    check(res, {
      "summary: 200": (r) => r.status === 200,
      "summary: tem stats": (r) => {
        try { return Array.isArray(r.json("stats")); } catch { return false; }
      },
    });
  }
}

/** Cenário isolado — ESCREVE no banco a cada chamada. */
export function diagnosticar(data) {
  const id = incidentId();
  const res = http.post(
    `${BASE_URL}/api/v1/incidents/${id}/diagnose`,
    null,
    requestParams(data, { cenario: "diagnose", name: "POST /incidents/:id/diagnose" }),
  );
  check(res, {
    "diagnose: 200": (r) => r.status === 200,
    "diagnose: tem hypothesis": (r) => {
      try { return typeof r.json("hypothesis") === "string"; } catch { return false; }
    },
  });
}

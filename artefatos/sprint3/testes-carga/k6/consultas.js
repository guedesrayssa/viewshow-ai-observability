/**
 * Teste de desempenho da API de consulta do View Show (apps/backend/api).
 *
 * Sucessor de artefatos/sprint2/testes-carga/k6/consultas.js, reescrito para
 * o contrato atual do monólito modular (refactor(api): colapsa os
 * microsserviços num monólito modular). As rotas mudaram:
 *
 *   /dashboard/summary          → /api/v1/dashboard/overview
 *   /incidents/:id/evidence     → /api/v1/incidents/:id/diagnosis (GET)
 *   POST /incidents/:id/diagnose → REMOVIDO (diagnóstico agora é leitura;
 *                                  não há mais cenário de escrita a isolar)
 *   /golden-set                 → REMOVIDO (sem rota pública)
 *   —                           → /api/v1/monitoring/overview (NOVO)
 *
 * SLA: RNF14 — "o dashboard e as APIs de consulta devem retornar os
 * resultados de uma busca filtrada em até 2 segundos para 95% das
 * solicitações (P95)".
 *
 * Carga: 137 req/s = pico de 4,1 M sessões simultâneas
 * (entendimento_negocio.md) dividido por 1.000. Fator de escala declarado.
 *
 * Modelo ABERTO (arrival-rate): o painel de um SRE não espera a API ficar
 * rápida para o próximo operador abrir a tela.
 *
 * LIMITE JÁ NO CÓDIGO — leia antes de rodar `load`/`breakpoint`/`spike`:
 * app.ts aplica um rate limit de 180 req/min POR IP (rateLimiter(180) em
 * src/app.ts), contado depois do /health e do /metrics. Um gerador k6 rodando
 * de uma única máquina é UM IP: isso teta o throughput observável em ~3 req/s,
 * bem abaixo dos 137 req/s do RNF14, mesmo que a API aguente mais. Isso não é
 * bug deste script — é o comportamento real do backend hoje. Ou o k6 roda
 * distribuído (várias origens/IPs), ou o time do backend libera/ajusta o
 * limite para a janela do teste. Este script NÃO altera o rate limiter; ele
 * apenas identifica e conta os 429 (ver métrica `rate_limited_total` e o
 * aviso no handleSummary).
 *
 * DADO: dashboard/overview e monitoring/overview leem projeções
 * (VIEW#OVERVIEW#.../VIEW#MONITORING#...). seed-carga.js já grava algumas
 * dessas projeções (idade variada, para cobrir vários presets de window),
 * mas elas ENVELHECEM da mesma forma que os incidentes — rode o teste logo
 * após semear. Por isso os dois endpoints continuam tratados como "200 ou
 * 503": 503 (DATA_UNAVAILABLE) é o estado esperado quando a janela pedida já
 * não alcança nenhuma projeção semeada, não uma falha deste teste. GET
 * /incidents e seus detalhes leem itens físicos e SÃO populáveis por
 * scripts/seed-carga.cjs — por isso continuam exigindo 200.
 *
 * AUTENTICAÇÃO MUDOU: não existe mais POST /auth/login (login federado via
 * Cognito/OIDC, hoje 503 FEATURE_UNAVAILABLE). `lib/session.js` forja o
 * cookie de sessão localmente — exige `-e AUTH_COOKIE_SECRET=<mesmo segredo
 * do processo da API sob teste>` (ver cabeçalho daquele arquivo).
 *
 * USO:
 *   (cd apps/backend/api && node scripts/seed-carga.cjs)   # ver README.md
 *   k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<32+ chars> -e MODE=smoke consultas.js
 *   k6 run -e BASE_URL=... -e AUTH_COOKIE_SECRET=... -e MODE=load consultas.js   # grava resumo-load.json (ver handleSummary)
 */

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { forgeSessionCookie, authParams } from "./lib/session.js";

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

/** IDs são ordinais determinísticos gerados por scripts/seed-carga.cjs. */
function incidentId() {
  const n = 1 + Math.floor(Math.random() * INCIDENT_COUNT);
  return `inc-${String(n).padStart(6, "0")}`;
}

const latenciaLeve = new Trend("vs_leve_ms");
const latenciaPesada = new Trend("vs_pesada_ms");
const latenciaDiagnostico = new Trend("vs_diagnostico_ms");
const rateLimited = new Counter("rate_limited_total");
const projecaoIndisponivel = new Counter("projecao_indisponivel_total");

/* ------------------------------ cenários ------------------------------ */

const CENARIOS = {
  // 1. Confere que script e API funcionam antes de gastar carga.
  smoke: { executor: "constant-vus", vus: 1, duration: "30s" },

  // 2. A rodada do relatório: carga média sustentada, com aquecimento.
  load: {
    executor: "ramping-arrival-rate",
    startRate: 10,
    timeUnit: "1s",
    preAllocatedVUs: 100,
    maxVUs: 800,
    stages: [
      { duration: "30s", target: RATE },
      { duration: "3m", target: RATE },
      { duration: "15s", target: 0 },
    ],
  },

  // 3. O joelho da curva — faixa alargada até um pouco acima do alvo de
  //    negócio (137 req/s) porque o teto real depende do rate limiter (ver
  //    aviso no topo do arquivo), não só da API.
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

  // 4b. Estresse: carga SUSTENTADA acima da capacidade — observa
  //     comportamento e recuperação, diferente da rajada breve do spike.
  estresse: {
    executor: "ramping-arrival-rate",
    startRate: RATE,
    timeUnit: "1s",
    preAllocatedVUs: 200,
    maxVUs: 1500,
    stages: [
      { duration: "30s", target: RATE },
      { duration: "30s", target: RATE * STRESS_MULTIPLIER },
      { duration: "3m", target: RATE * STRESS_MULTIPLIER },
      { duration: "30s", target: RATE },
      { duration: "1m", target: RATE },
    ],
  },

  // 5. Vazamento de memória/degradação sobre base estática (ver limitação
  //    nº5 do README: sem Ingestão real, o soak não cresce a base).
  soak: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: "2h",
    preAllocatedVUs: 200,
    maxVUs: 800,
  },
};

if (!CENARIOS[MODE]) {
  throw new Error(`MODE inválido: ${MODE}. Use: ${Object.keys(CENARIOS).join(", ")}`);
}

export const options = {
  scenarios: { [MODE]: CENARIOS[MODE] },
  thresholds: {
    ...(["load", "soak"].includes(MODE)
      ? {
          http_req_duration: ["p(95)<2000"],
          http_req_failed: ["rate<0.01"],
          checks: ["rate>0.99"],
        }
      : {}),
    ...(MODE === "smoke" ? { http_req_failed: ["rate<0.01"], checks: ["rate==1"] } : {}),
    ...(MODE === "load" ? { http_reqs: [`rate>${Math.floor(RATE * 0.95)}`] } : {}),
  },
  // Sem isso o k6 agrega /incidents/inc-000001 e /incidents/inc-000002 como
  // URLs diferentes e o resumo vira ilegível.
  discardResponseBodies: false,
};

/* ------------------------------- setup -------------------------------- */

export function setup() {
  const cookie = forgeSessionCookie({ role: "engineer" });
  return { cookie };
}

/** 200: a projeção já foi publicada. 503 DATA_UNAVAILABLE: ainda não há
 *  Ingestão publicando — estado real e esperado hoje, não falha do teste. */
function checaProjecao(res, rotulo) {
  if (res.status === 503) projecaoIndisponivel.add(1, { rota: rotulo });
  return check(
    res,
    { [`${rotulo}: 200 (publicada) ou 503 (ingestão ainda não publicou)`]: (r) => r.status === 200 || r.status === 503 },
  );
}

function contaRateLimit(res, rotulo) {
  if (res.status === 429) rateLimited.add(1, { rota: rotulo });
}

/* ------------------------------ default ------------------------------- */

export default function (data) {
  const params = (tags) => authParams(data.cookie, tags);
  const sorteio = Math.random();

  if (sorteio < 0.35) {
    // A — leitura PESADA: window=24h varre até 25 buckets de hora em
    //     paralelo. Pior caso real, o que a tela de incidentes usa.
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=24h`,
      params({ cenario: "pesada", name: "GET /api/v1/incidents?window=24h" }),
    );
    latenciaPesada.add(res.timings.duration);
    contaRateLimit(res, "incidents_24h");
    check(res, {
      "pesada: 200": (r) => r.status === 200,
      "pesada: tem items": (r) => {
        try { return Array.isArray(r.json("data.items")); } catch { return false; }
      },
    });
  } else if (sorteio < 0.6) {
    // B — leitura LEVE: window=15m varre só 2 buckets.
    //     ⚠️ Só devolve dado se o seed rodou há menos de ~1 h.
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=15m`,
      params({ cenario: "leve", name: "GET /api/v1/incidents?window=15m" }),
    );
    latenciaLeve.add(res.timings.duration);
    contaRateLimit(res, "incidents_15m");
    check(res, { "leve: 200": (r) => r.status === 200 });
  } else if (sorteio < 0.78) {
    // C — DIAGNÓSTICO: Query única no GSI trace-index (bundle do
    //     incidente). Independe do relógio, não sofre com o envelhecimento
    //     do seed.
    const id = incidentId();
    const res = http.get(
      `${BASE_URL}/api/v1/incidents/${id}/diagnosis`,
      params({ cenario: "diagnostico", name: "GET /api/v1/incidents/:id/diagnosis" }),
    );
    latenciaDiagnostico.add(res.timings.duration);
    contaRateLimit(res, "diagnosis");
    check(res, {
      "diagnostico: 200": (r) => r.status === 200,
      "diagnostico: tem evidence": (r) => {
        try { return Array.isArray(r.json("data.evidence")); } catch { return false; }
      },
    });
  } else if (sorteio < 0.9) {
    // D — OVERVIEW: o que a tela de Visão Geral chama ao abrir.
    const res = http.get(
      `${BASE_URL}/api/v1/dashboard/overview`,
      params({ cenario: "overview", name: "GET /api/v1/dashboard/overview" }),
    );
    contaRateLimit(res, "overview");
    checaProjecao(res, "overview");
  } else {
    // E — MONITORING: novo endpoint (não existia no sprint2). Mesma
    //     dependência de projeção de ingestão que o overview.
    const res = http.get(
      `${BASE_URL}/api/v1/monitoring/overview`,
      params({ cenario: "monitoring", name: "GET /api/v1/monitoring/overview" }),
    );
    contaRateLimit(res, "monitoring");
    checaProjecao(res, "monitoring");
  }
}

/**
 * Substitui `--summary-export`: definir handleSummary() desativa aquela flag
 * nativa do k6, então este export cobre a mesma necessidade — grava o JSON
 * completo em resumo-<MODE>.json e ainda imprime os avisos específicos deste
 * backend (rate limit por IP, projeção de ingestão indisponível) que o
 * resumo padrão do k6 não destacaria.
 */
export function handleSummary(data) {
  const limitadas = data.metrics.rate_limited_total?.values?.count || 0;
  const semProjecao = data.metrics.projecao_indisponivel_total?.values?.count || 0;
  const avisos = [];
  if (limitadas > 0) {
    avisos.push(
      `⚠ ${limitadas} requisições receberam 429 RATE_LIMITED — o rate limit de ` +
        "180 req/min por IP (src/app.ts) provavelmente tetou o throughput bem " +
        "abaixo do RATE pedido. Ver aviso no topo de consultas.js.",
    );
  }
  if (semProjecao > 0) {
    avisos.push(
      `ℹ ${semProjecao} chamadas a overview/monitoring receberam 503 DATA_UNAVAILABLE — ` +
        "esperado enquanto apps/backend/ingestion-data não existe.",
    );
  }
  const linhas = [
    "Teste de desempenho — API de consulta (View Show)",
    `Modo: ${MODE} · RATE alvo: ${RATE} req/s`,
    "",
    ...avisos,
    "",
    `Resumo completo: resumo-${MODE}.json`,
  ];
  return {
    stdout: linhas.join("\n") + "\n",
    [`resumo-${MODE}.json`]: JSON.stringify(data, null, 2),
  };
}

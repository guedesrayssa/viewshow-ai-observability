/**
 * Teste de desempenho da API de consulta do View Show (apps/backend/api).
 * Cobre RNF14 (latência de consulta, p95 ≤ 2s) e RNF09 (disponibilidade),
 * varrendo `/api/v1/incidents` (lista, diagnóstico, eventos, paginação por
 * cursor), `/dashboard/overview` e `/monitoring/overview`.
 *
 * Carga alvo: 137 req/s (pico de 4,1M sessões simultâneas / fator de escala
 * 1.000 — ver entendimento_negocio.md). Modelo aberto (arrival-rate): a carga
 * não cai quando a API fica lenta, o que é necessário para revelar saturação.
 *
 * GOTCHAS OPERACIONAIS:
 *   - Rate limit de 180 req/min por IP (`rateLimiter(180)` em src/app.ts) teta
 *     o throughput observável de um gerador único a ~3 req/s, bem abaixo dos
 *     137 do RNF14 — não é bug deste script. Para medir capacidade real acima
 *     disso, rode distribuído (múltiplas origens) ou peça ao time de backend
 *     para ajustar o limite na janela do teste. 429s são contados em
 *     `rate_limited_total`, não descontados do resultado.
 *   - `dashboard/overview`/`monitoring/overview` dependem de snapshots que
 *     `seed-carga.cjs` grava com idade variada; eles envelhecem, então ambos
 *     aceitam 200 ou 503 (`DATA_UNAVAILABLE`) como resultado válido.
 *     `/incidents` e seus detalhes leem itens físicos e exigem 200 de verdade.
 *   - Autenticação é federada (Cognito/OIDC) e não tem `POST /auth/login`;
 *     `lib/session.js` forja o cookie de sessão localmente — exige
 *     `-e AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob teste>`.
 *   - Cada chamada carrega `X-Request-Id` (prefixo `k6-consultas-<MODE>`) para
 *     correlação com os logs da API (ver `loadtest/README.md`, seção
 *     Observabilidade).
 *
 * USO:
 *   (cd apps/backend/api && node scripts/seed-carga.cjs)
 *   k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<32+ chars> -e MODE=smoke consultas.js
 *   k6 run -e BASE_URL=... -e AUTH_COOKIE_SECRET=... -e MODE=load consultas.js   # grava resumo-load.json
 */

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { forgeSessionCookie, authParams } from "./lib/session.js";

// 429 (rate limiter) e 503 (projeção ainda não publicada) são estados
// esperados e já contados em métricas próprias (rate_limited_total,
// projecao_indisponivel_total) — sem isto, http_req_failed (usado nos
// thresholds de smoke/load/soak) reprovaria o run só por causa deles, mesmo
// com a API funcionando corretamente. Confirmado rodando localmente: um
// único VU excede 180 req/min em poucos segundos, então isto não é opcional.
http.setResponseCallback(http.expectedStatuses(200, 429, 503));

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
const latenciaEvents = new Trend("vs_events_ms");
const rateLimited = new Counter("rate_limited_total");
const projecaoIndisponivel = new Counter("projecao_indisponivel_total");
const paginaSeguinte = new Counter("pagina_seguinte_total");

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
 *  Ingestão publicando. 429: rate limiter — nenhum dos três é falha do
 *  teste (ver rate_limited_total/projecao_indisponivel_total). */
function checaProjecao(res, rotulo) {
  if (res.status === 503) projecaoIndisponivel.add(1, { rota: rotulo });
  return check(
    res,
    { [`${rotulo}: 200, 503 (ingestão não publicou) ou 429 (rate limit)`]: (r) => r.status === 200 || r.status === 503 || r.status === 429 },
  );
}

function contaRateLimit(res, rotulo) {
  if (res.status === 429) rateLimited.add(1, { rota: rotulo });
}

/** true se a resposta é o resultado de negócio esperado OU um 429 de rate
 *  limiter — nunca um "bug" na ausência de outra checagem mais específica. */
function statusOuRateLimited(res, status) {
  return res.status === status || res.status === 429;
}

/* ------------------------------ default ------------------------------- */

export default function (data) {
  const params = (tags) => authParams(data.cookie, tags, `k6-consultas-${MODE}`);
  const sorteio = Math.random();

  if (sorteio < 0.3) {
    // A — leitura PESADA: window=24h varre até 25 buckets de hora em
    //     paralelo. Pior caso real, o que a tela de incidentes usa.
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=24h`,
      params({ cenario: "pesada", name: "GET /api/v1/incidents?window=24h" }),
    );
    latenciaPesada.add(res.timings.duration);
    contaRateLimit(res, "incidents_24h");
    check(res, {
      "pesada: 200 (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200),
      "pesada: tem items (quando 200)": (r) => {
        if (r.status === 429) return true;
        try { return Array.isArray(r.json("data.items")); } catch { return false; }
      },
    });
  } else if (sorteio < 0.5) {
    // B — leitura LEVE: window=15m varre só 2 buckets.
    //     ⚠️ Só devolve dado se o seed rodou há menos de ~1 h.
    const res = http.get(
      `${BASE_URL}/api/v1/incidents?window=15m`,
      params({ cenario: "leve", name: "GET /api/v1/incidents?window=15m" }),
    );
    latenciaLeve.add(res.timings.duration);
    contaRateLimit(res, "incidents_15m");
    check(res, { "leve: 200 (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200) });
  } else if (sorteio < 0.65) {
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
      "diagnostico: 200 (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200),
      "diagnostico: tem evidence (quando 200)": (r) => {
        if (r.status === 429) return true;
        try { return Array.isArray(r.json("data.evidence")); } catch { return false; }
      },
    });
  } else if (sorteio < 0.75) {
    // D — OVERVIEW: o que a tela de Visão Geral chama ao abrir.
    const res = http.get(
      `${BASE_URL}/api/v1/dashboard/overview`,
      params({ cenario: "overview", name: "GET /api/v1/dashboard/overview" }),
    );
    contaRateLimit(res, "overview");
    checaProjecao(res, "overview");
  } else if (sorteio < 0.83) {
    // E — MONITORING: novo endpoint (não existia no sprint2). Mesma
    //     dependência de projeção de ingestão que o overview.
    const res = http.get(
      `${BASE_URL}/api/v1/monitoring/overview`,
      params({ cenario: "monitoring", name: "GET /api/v1/monitoring/overview" }),
    );
    contaRateLimit(res, "monitoring");
    checaProjecao(res, "monitoring");
  } else if (sorteio < 0.93) {
    // F — EVENTS: lista de eventos do incidente. Resposta é um placeholder
    //     estável hoje (items vazios, avisos fixos de capacidade ainda não
    //     configurada — incident-use-cases.ts events()), mas a rota é
    //     pública, real, e não envelhece — só exige o incidente existir.
    const id = incidentId();
    const res = http.get(
      `${BASE_URL}/api/v1/incidents/${id}/events`,
      params({ cenario: "events", name: "GET /api/v1/incidents/:id/events" }),
    );
    latenciaEvents.add(res.timings.duration);
    contaRateLimit(res, "events");
    check(res, { "events: 200 (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200) });
  } else {
    // G — PAGINAÇÃO: limit baixo força hasMore=true com os INCIDENT_COUNT
    //     incidentes do seed; segue nextCursor para a página seguinte.
    //     Único cenário que exercita CursorCodec (AES-256-GCM) de ponta a
    //     ponta — um cursor quebrado (ex.: CURSOR_SECRET divergente do
    //     processo da API) só apareceria aqui, não nos outros cenários.
    const pagina1 = http.get(
      `${BASE_URL}/api/v1/incidents?window=24h&limit=5`,
      params({ cenario: "paginacao", name: "GET /api/v1/incidents (pagina 1)" }),
    );
    contaRateLimit(pagina1, "paginacao_p1");
    check(pagina1, { "paginacao: pagina 1 (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200) });
    if (pagina1.status === 200) {
      let cursor = null;
      try { cursor = pagina1.json("data.page.nextCursor"); } catch { /* segue sem cursor */ }
      if (cursor) {
        paginaSeguinte.add(1);
        const pagina2 = http.get(
          `${BASE_URL}/api/v1/incidents?window=24h&limit=5&cursor=${encodeURIComponent(cursor)}`,
          params({ cenario: "paginacao", name: "GET /api/v1/incidents (pagina 2, cursor)" }),
        );
        contaRateLimit(pagina2, "paginacao_p2");
        check(pagina2, { "paginacao: pagina 2, cursor (ou 429 rate limit)": (r) => statusOuRateLimited(r, 200) });
      }
    }
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
  const paginadas = data.metrics.pagina_seguinte_total?.values?.count || 0;
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
  avisos.push(
    `ℹ Cenário G seguiu o cursor para a página 2 em ${paginadas} iteração(ões) ` +
      "— 0 aqui indica que INCIDENT_COUNT/limit não geraram hasMore=true, não " +
      "necessariamente um bug de paginação.",
  );
  avisos.push(
    `ℹ Cada requisição carregou X-Request-Id prefixado "k6-consultas-${MODE}", gravado ` +
      "em request_id no log JSON da API (src/app.ts) — filtrável na saída padrão do " +
      "processo hoje; ver seção Observabilidade do README para Prometheus/Tempo.",
  );
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

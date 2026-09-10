/**
 * Drenagem, acúmulo e frescor ponta a ponta da Ingestão — PREPARADO, NÃO
 * EXECUTÁVEL AINDA.
 *
 * Este script não tem equivalente em sprints anteriores: não existia rota de
 * ingestão no contrato atual para testar. Ele fica pronto para o dia em que
 * apps/backend/ingestion-data (hoje só um README reservando a pasta) e a
 * rota de importação do Backend (D9 em artefatos/arquitetura/visao-geral.md)
 * existirem — sem precisar reescrever a lógica de carga, só os ENDPOINTS.*
 * abaixo caso os nomes finais divirjam do que está assumido aqui.
 *
 * ============================== POR QUE NÃO RODA HOJE ==============================
 * A arquitetura aprovada (visao-geral.md, ingestao-e-dados.md) define a
 * Ingestão como uma tarefa ECS Fargate SEM porta HTTP: ela lê o ARGUS/MySQL
 * (ou um dump restaurado) via comandos `sync`/`backfill`, nunca por um POST
 * de eventos. O único ponto de entrada HTTP previsto é o Backend disparando
 * essa tarefa (D9: browser sobe o dump pro S3 → Backend inicia RunTask →
 * ImportJob acompanhado até COMPLETED/FAILED). Nenhuma dessas rotas existe em
 * src/app.ts hoje, e dashboard-queries.ts já assume explicitamente que "o
 * pipeline batch atual não possui fila" (rejeita flowMetric=queue_depth com
 * 422). setup() abaixo comprova isso contra o BASE_URL de verdade antes de
 * rodar qualquer cenário: se o endpoint de import ainda não existir, o
 * script para com uma mensagem clara em vez de fingir medir alguma coisa.
 *
 * ============================== O QUE CADA CENÁRIO VAI MEDIR ==============================
 * O requisito é 10.000 eventos/min por 15 min = 150.000 eventos por janela.
 * Como a Ingestão é batch (não streaming), "drenagem" aqui é "quanto tempo o
 * processamento de uma janela de 150 mil registros leva para ficar
 * consultável" — não uma fila HTTP esvaziando.
 *
 *   drenagem — dispara UMA importação representando a janela de 150 mil
 *     eventos (EVENT_RATE × WINDOW_MINUTES) e mede o tempo até o ImportJob
 *     chegar a COMPLETED. Threshold: bem abaixo de WINDOW_MINUTES.
 *   acumulo — dispara BACKLOG_BATCHES janelas em sequência rápida (2, 3 ou
 *     4, via -e BACKLOG_BATCHES=N) simulando atraso represado, e mede quanto
 *     tempo o sistema leva para processar todas e alcançar o watermark mais
 *     recente — o "recupera o atraso?" do requisito.
 *   frescor — dispara uma importação, marca t0, espera o ImportJob concluir
 *     (t1) e então faz polling em /api/v1/dashboard/overview até o
 *     watermark (`meta.freshness[].observedThrough`) avançar além de t0
 *     (t2). Reporta ingestion_duration (t1-t0) e frescor ponta a ponta
 *     (t2-t0) — do recebimento até a disponibilidade para consulta.
 *
 * ============================== SUPOSIÇÕES A REVISAR QUANDO O CONTRATO EXISTIR ==============================
 * Os paths abaixo são a leitura mais direta de D9/visao-geral.md, não um
 * contrato publicado — ajuste ENDPOINTS.* (ou as flags -e) quando a rota
 * real existir em apps/backend/api/contracts/openapi/.
 *
 * USO (quando a Ingestão existir):
 *   k6 run -e BASE_URL=http://localhost:3000 -e MODE=drenagem ingestao-batch.js
 *   k6 run -e BASE_URL=... -e MODE=acumulo -e BACKLOG_BATCHES=3 ingestao-batch.js
 *   k6 run -e BASE_URL=... -e MODE=frescor ingestao-batch.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { login, authParams } from "./lib/session.js";

const BASE_URL = __ENV.BASE_URL;
const MODE = __ENV.MODE || "drenagem";
const EVENT_RATE = Number(__ENV.EVENT_RATE || 10000); // eventos/min, requisito de negócio
const WINDOW_MINUTES = Number(__ENV.WINDOW_MINUTES || 15);
const BATCH_SIZE = EVENT_RATE * WINDOW_MINUTES; // 150.000 por padrão
const BACKLOG_BATCHES = Number(__ENV.BACKLOG_BATCHES || 1);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 5);
const POLL_TIMEOUT_S = Number(__ENV.POLL_TIMEOUT_S || WINDOW_MINUTES * 60 * 2);

// Assumidos a partir de D9 (visao-geral.md) — troque aqui quando o contrato
// real for publicado; nenhum outro trecho do script precisa mudar.
const ENDPOINTS = {
  importTrigger: __ENV.IMPORT_TRIGGER_PATH || "/api/v1/imports",
  importStatus: (id) => (__ENV.IMPORT_STATUS_PATH || "/api/v1/imports/:id").replace(":id", id),
  monitoring: __ENV.MONITORING_PATH || "/api/v1/monitoring/overview",
  overview: "/api/v1/dashboard/overview",
};

if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>:3000");
if (!["drenagem", "acumulo", "frescor"].includes(MODE)) {
  throw new Error("MODE inválido. Use: drenagem, acumulo ou frescor");
}
if (!Number.isInteger(BACKLOG_BATCHES) || BACKLOG_BATCHES < 1 || BACKLOG_BATCHES > 4) {
  throw new Error("BACKLOG_BATCHES deve ser um inteiro entre 1 e 4 (requisito: 2, 3 ou 4 lotes)");
}

const drenagemSegundos = new Trend("ingestion_drain_seconds", true);
const frescorSegundos = new Trend("ingestion_end_to_end_freshness_seconds", true);
const janelasCompletadas = new Counter("ingestion_windows_completed");

export const options = {
  // Um cenário de UMA iteração: o "tráfego" aqui não é taxa de requisições,
  // é o tempo de processamento de janelas inteiras — não faz sentido em
  // arrival-rate. A carga de 150 mil eventos está no payload/parâmetro da
  // importação, não em VUs concorrentes.
  scenarios: {
    [MODE]: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: `${POLL_TIMEOUT_S + 60}s` },
  },
  thresholds: {
    ...(MODE === "drenagem"
      ? { ingestion_drain_seconds: [`p(100)<${WINDOW_MINUTES * 60}`] } // "bem antes dos 15 min"
      : {}),
    ...(MODE === "frescor" ? { ingestion_end_to_end_freshness_seconds: ["p(100)<900"] } : {}),
  },
};

/**
 * Confirma que o endpoint de import existe antes de gastar qualquer carga.
 * 404 RESOURCE_NOT_FOUND do middleware genérico de rota (src/app.ts) = rota
 * ainda não implementada → aborta com mensagem clara. Qualquer outra
 * resposta (400 de validação, 401, 202...) prova que a rota já existe.
 */
function probeImportEndpoint(cookie) {
  const res = http.post(
    `${BASE_URL}${ENDPOINTS.importTrigger}`,
    JSON.stringify({ probe: true }),
    authParams(cookie, { name: "probe import endpoint" }),
  );
  let code = null;
  try { code = res.json("error.code"); } catch { /* corpo não é o envelope de erro */ }
  if (res.status === 404 && code === "RESOURCE_NOT_FOUND") {
    throw new Error(
      `${ENDPOINTS.importTrigger} ainda não existe (HTTP 404 RESOURCE_NOT_FOUND). ` +
        "Isso é esperado: apps/backend/ingestion-data e a rota de importação do " +
        "Backend (D9, artefatos/arquitetura/visao-geral.md) ainda não foram " +
        "implementados por quem está com essa frente. Este script fica pronto " +
        "para quando existirem — nada a fazer aqui até lá.",
    );
  }
}

export function setup() {
  const cookie = login(BASE_URL);
  probeImportEndpoint(cookie);
  return { cookie };
}

/** Dispara uma janela de importação. Ajuste o corpo quando o contrato existir. */
function triggerImport(cookie, label) {
  return http.post(
    `${BASE_URL}${ENDPOINTS.importTrigger}`,
    JSON.stringify({
      windowMinutes: WINDOW_MINUTES,
      expectedEventCount: BATCH_SIZE,
      label,
    }),
    authParams(cookie, { name: "POST /imports", label }),
  );
}

/** Faz polling do ImportJob até COMPLETED/FAILED ou estourar POLL_TIMEOUT_S. */
function waitForCompletion(cookie, importId, label) {
  const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const res = http.get(`${BASE_URL}${ENDPOINTS.importStatus(importId)}`, authParams(cookie, { name: "GET /imports/:id", label }));
    let status = null;
    try { status = res.json("data.status"); } catch { /* segue tentando */ }
    if (status === "COMPLETED") return true;
    if (status === "FAILED") {
      check(res, { [`${label}: ImportJob não deve falhar`]: () => false });
      return false;
    }
    sleep(POLL_INTERVAL_S);
  }
  check(null, { [`${label}: ImportJob concluiu dentro do timeout`]: () => false });
  return false;
}

/** Espera o watermark de /dashboard/overview avançar além de `after`. */
function waitForFreshness(cookie, after) {
  const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const res = http.get(`${BASE_URL}${ENDPOINTS.overview}`, authParams(cookie, { name: "GET /dashboard/overview (poll frescor)" }));
    if (res.status === 200) {
      try {
        const freshness = res.json("meta.freshness") || [];
        const observed = freshness
          .map((entry) => entry.observedThrough)
          .filter(Boolean)
          .map((iso) => new Date(iso).getTime());
        if (observed.some((timestamp) => timestamp >= after)) return true;
      } catch { /* corpo inesperado, segue tentando até o timeout */ }
    }
    sleep(POLL_INTERVAL_S);
  }
  return false;
}

export default function (data) {
  if (MODE === "drenagem") {
    const t0 = Date.now();
    const disparo = triggerImport(data.cookie, "drenagem-unica");
    check(disparo, { "drenagem: import aceito (202)": (r) => r.status === 202 });
    const importId = (() => { try { return disparo.json("data.importId"); } catch { return null; } })();
    const concluiu = importId && waitForCompletion(data.cookie, importId, "drenagem");
    if (concluiu) {
      const elapsedS = (Date.now() - t0) / 1000;
      drenagemSegundos.add(elapsedS);
      janelasCompletadas.add(1);
      check(null, { [`drenagem: ${BATCH_SIZE} eventos processados em < ${WINDOW_MINUTES} min`]: () => elapsedS < WINDOW_MINUTES * 60 });
    }
  }

  if (MODE === "acumulo") {
    const t0 = Date.now();
    const disparos = [];
    for (let i = 0; i < BACKLOG_BATCHES; i += 1) {
      disparos.push(triggerImport(data.cookie, `acumulo-lote-${i + 1}-de-${BACKLOG_BATCHES}`));
    }
    disparos.forEach((res, i) =>
      check(res, { [`acumulo: lote ${i + 1}/${BACKLOG_BATCHES} aceito (202)`]: (r) => r.status === 202 }),
    );
    const ids = disparos.map((res) => { try { return res.json("data.importId"); } catch { return null; } });
    const todasConcluiram = ids.every((id, i) => id && waitForCompletion(data.cookie, id, `acumulo-lote-${i + 1}`));
    if (todasConcluiram) {
      const elapsedS = (Date.now() - t0) / 1000;
      janelasCompletadas.add(BACKLOG_BATCHES);
      check(null, {
        [`acumulo: ${BACKLOG_BATCHES} lotes represados recuperados`]: () => true,
        [`acumulo: recuperação em < ${BACKLOG_BATCHES * WINDOW_MINUTES} min`]: () => elapsedS < BACKLOG_BATCHES * WINDOW_MINUTES * 60,
      });
    }
  }

  if (MODE === "frescor") {
    const t0 = Date.now();
    const disparo = triggerImport(data.cookie, "frescor-ponta-a-ponta");
    check(disparo, { "frescor: import aceito (202)": (r) => r.status === 202 });
    const importId = (() => { try { return disparo.json("data.importId"); } catch { return null; } })();
    const ingestaoConcluiu = importId && waitForCompletion(data.cookie, importId, "frescor");
    if (ingestaoConcluiu) {
      const disponivel = waitForFreshness(data.cookie, t0);
      check(null, { "frescor: dado apareceu na consulta antes do timeout": () => disponivel });
      if (disponivel) frescorSegundos.add((Date.now() - t0) / 1000);
    }
  }
}

export function handleSummary(data) {
  return {
    stdout:
      `Ingestão — modo ${MODE} · janela ${WINDOW_MINUTES} min · ${BATCH_SIZE} eventos` +
      (MODE === "acumulo" ? ` × ${BACKLOG_BATCHES} lotes` : "") +
      "\n",
    [`resumo-ingestao-${MODE}.json`]: JSON.stringify(data, null, 2),
  };
}

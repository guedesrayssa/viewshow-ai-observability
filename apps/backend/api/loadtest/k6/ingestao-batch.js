/**
 * Drenagem, acúmulo e frescor ponta a ponta da Ingestão (RNF01/RNF02/RNF03) —
 * PREPARADO, NÃO EXECUTA DE PONTA A PONTA HOJE.
 *
 * POR QUE NÃO RODA HOJE: as rotas HTTP de import existem em src/app.ts (POST
 * /api/v1/imports, POST /api/v1/imports/:id/complete, GET /api/v1/imports/:id
 * — ver public-routes.ts), mas o adaptador por trás delas
 * (`UnavailableImportControl`) é fail-closed por construção: toda chamada
 * autenticada e com corpo válido responde incondicionalmente 503
 * FEATURE_UNAVAILABLE ("a importação requer S3 e uma tarefa de ingestão
 * configurados"), documentado em apps/backend/README.md — deliberado, não um
 * bug. `setup()` abaixo prova esse estado contra o BASE_URL real antes de
 * rodar qualquer cenário e aborta com mensagem clara caso contrário.
 *
 * A arquitetura aprovada define a Ingestão como uma tarefa ECS Fargate sem
 * porta HTTP (lê ARGUS/MySQL via `sync`/`backfill`); o único ponto de entrada
 * HTTP é o Backend disparando essa tarefa (upload do dump pro S3 → RunTask →
 * ImportJob acompanhado até COMPLETED/FAILED). `dashboard-queries.ts` já
 * assume que "o pipeline batch atual não possui fila" (rejeita
 * flowMetric=queue_depth com 422).
 *
 * ACHADO A LEMBRAR (fora do escopo do k6): os três handlers de import em
 * src/app.ts nunca chamam `response.json()`/`.end()` no caminho de sucesso —
 * invisível hoje porque o adaptador sempre lança antes de chegar lá, mas vai
 * travar a requisição sem resposta no dia em que o adaptador real resolver
 * sem lançar.
 *
 * O QUE CADA CENÁRIO MEDE (requisito: 10.000 eventos/min por 15 min = 150.000
 * eventos por janela; como a Ingestão é batch, não streaming, "drenagem" é
 * "quanto tempo uma janela de 150 mil registros leva para ficar consultável",
 * não uma fila HTTP esvaziando):
 *   drenagem — dispara uma importação representando a janela de 150 mil
 *     eventos (EVENT_RATE × WINDOW_MINUTES) e mede o tempo até o ImportJob
 *     chegar a COMPLETED. Threshold: bem abaixo de WINDOW_MINUTES.
 *   acumulo — dispara BACKLOG_BATCHES janelas em sequência rápida (2, 3 ou 4,
 *     via -e BACKLOG_BATCHES=N), simulando atraso represado ("fila cheia"
 *     nesta arquitetura), e mede o tempo até processar todas e alcançar o
 *     watermark mais recente.
 *   frescor — dispara uma importação, marca t0, espera o ImportJob concluir
 *     (t1) e faz polling em /api/v1/dashboard/overview até o watermark
 *     (`meta.freshness[].observedThrough`) avançar além de t0 (t2). Reporta
 *     ingestion_duration (t1-t0) e frescor ponta a ponta (t2-t0).
 * Timeout de dependência é modelado por `POLL_TIMEOUT_S`: se o ImportJob não
 * chegar a COMPLETED dentro da janela, o check de timeout reprova
 * explicitamente em vez de travar o run.
 *
 * SUPOSIÇÕES A REVISAR QUANDO O ADAPTADOR REAL EXISTIR: o request de POST
 * /imports já segue o contrato publicado (startImportBodySchema); a FORMA de
 * uma resposta bem-sucedida (202 com data.importId, polling por data.status)
 * continua sendo suposição, porque o adaptador nunca chega a produzi-la hoje.
 * Ajuste `triggerImport()`/`waitForCompletion()` quando isso for conhecido.
 *
 * USO (quando o adaptador de import sair do estado fail-closed):
 *   k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<32+ chars> -e MODE=drenagem ingestao-batch.js
 *   k6 run -e BASE_URL=... -e AUTH_COOKIE_SECRET=... -e MODE=acumulo -e BACKLOG_BATCHES=3 ingestao-batch.js
 *   k6 run -e BASE_URL=... -e AUTH_COOKIE_SECRET=... -e MODE=frescor ingestao-batch.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { forgeSessionCookie, authParams } from "./lib/session.js";

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

/** Corpo válido de POST /imports (startImportBodySchema) para uso no probe e
 *  em cada disparo — sha256 fake de 64 hex chars só para passar a validação. */
function importBody(label) {
  return {
    fileName: `k6-${label}.ndjson`,
    sizeBytes: BATCH_SIZE * 200, // estimativa; não é validado além de positivo
    sha256: "0".repeat(64),
    partCount: 1,
  };
}

/**
 * Confirma o estado real do endpoint de import antes de gastar qualquer
 * carga. A rota EXISTE hoje (ao contrário do que uma versão anterior deste
 * script assumia), mas o adaptador (UnavailableImportControl) é fail-closed
 * incondicional: 503 FEATURE_UNAVAILABLE é o resultado esperado enquanto S3 e
 * a tarefa de ingestão não forem configurados — o script aborta com mensagem
 * clara nesse caso. 404 significa que a rota mudou de novo (contrato
 * divergente deste script). Qualquer outra resposta indica que o adaptador
 * saiu do estado fail-closed — hora de revisar as suposições no cabeçalho.
 */
function probeImportEndpoint(cookie) {
  const res = http.post(
    `${BASE_URL}${ENDPOINTS.importTrigger}`,
    JSON.stringify(importBody("probe")),
    authParams(cookie, { name: "probe import endpoint" }, "k6-ingestao"),
  );
  let code = null;
  try { code = res.json("error.code"); } catch { /* corpo não é o envelope de erro */ }
  if (res.status === 503 && code === "FEATURE_UNAVAILABLE") {
    throw new Error(
      `${ENDPOINTS.importTrigger} existe mas está fail-closed (503 FEATURE_UNAVAILABLE: ` +
        '"a importação requer S3 e uma tarefa de ingestão configurados"). ' +
        "Isso é deliberado (UnavailableImportControl em src/modules/imports/adapters/, " +
        "ver apps/backend/README.md) até o adaptador real ser configurado. Este script " +
        "fica pronto para quando isso acontecer — nada a fazer aqui até lá.",
    );
  }
  if (res.status === 404) {
    throw new Error(
      `${ENDPOINTS.importTrigger} respondeu 404 — a rota pode ter mudado de novo. ` +
        "Confira apps/backend/api/src/http/public-routes.ts antes de assumir que este " +
        "script está desatualizado por outro motivo.",
    );
  }
}

export function setup() {
  const cookie = forgeSessionCookie({ role: "engineer" });
  probeImportEndpoint(cookie);
  return { cookie };
}

/** Dispara uma janela de importação. Ajuste o corpo quando a forma real da
 *  resposta de sucesso for conhecida (ver nota no cabeçalho do arquivo). */
function triggerImport(cookie, label) {
  return http.post(
    `${BASE_URL}${ENDPOINTS.importTrigger}`,
    JSON.stringify(importBody(label)),
    authParams(cookie, { name: "POST /imports", label }, "k6-ingestao"),
  );
}

/** Faz polling do ImportJob até COMPLETED/FAILED ou estourar POLL_TIMEOUT_S. */
function waitForCompletion(cookie, importId, label) {
  const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const res = http.get(`${BASE_URL}${ENDPOINTS.importStatus(importId)}`, authParams(cookie, { name: "GET /imports/:id", label }, "k6-ingestao"));
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
    const res = http.get(`${BASE_URL}${ENDPOINTS.overview}`, authParams(cookie, { name: "GET /dashboard/overview (poll frescor)" }, "k6-ingestao"));
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

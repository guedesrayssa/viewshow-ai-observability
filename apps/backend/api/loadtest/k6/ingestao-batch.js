/**
 * Testes de carga e resiliência da API de ingestão (Sprint 5) — ver
 * artefatos/sprint5/testes-carga-ingestao.md.
 *
 * Fluxo real de uma importação (contracts/src/index.ts e src/app.ts):
 *   1. POST /api/v1/imports {fileName, sizeBytes, snapshotExtractedOn}
 *      + header Idempotency-Key → 201, estado UPLOADING (ou 409
 *      IMPORT_IN_PROGRESS com details.importId quando já existe uma ativa).
 *   2. POST /api/v1/imports/:id/parts {parts:[{partNumber, checksumSha256}]}
 *      (até 20 por chamada) → URLs pré-assinadas + headers do S3.
 *   3. PUT de cada parte de 16 MiB direto no S3 → ETag.
 *   4. POST /api/v1/imports/:id/complete {parts:[{partNumber, etag,
 *      checksumSha256}]} + Idempotency-Key → 202.
 *   5. GET /api/v1/imports/:id até READY ou FAILED. `progress` (kind
 *      "stage") traz recordsRead/recordsWritten/recordsRejected.
 *   6. (opcional, ACTIVATE=true) POST /api/v1/imports/:id/activate.
 *
 * Não existe rota para cancelar uma importação, e um upload abandonado
 * segura a trava por 24 h (uploadExpiresAt). Por isso os modos que criam uma
 * importação sem concluí-la (pico e limite) a concluem no teardown com o
 * DUMP informado, liberando a vaga para o teste seguinte.
 *
 * MODOS
 *   smoke    (CG-01) uma importação pequena de ponta a ponta.
 *   drenagem (CG-02 / CG-05) uma importação de DUMP; mede duração por
 *            estado, vazão em eventos/s e confere EXPECTED_EVENTS.
 *   pico     (CG-04) rajada ramping-arrival-rate: 20% POST /imports,
 *            70% GET /imports/:id, 10% GET /imports. Exatamente um 201.
 *   limite   (RS-06) nominal 1 req/s → rajada BURST_RATE req/s → pausa →
 *            recuperação 1 req/s, com uma importação ativa.
 *   frescor  (CG-03) polling em /dashboard/overview até
 *            meta.freshness[].observedThrough ≥ EXPECT_OBSERVED_THROUGH;
 *            o lote é publicado antes por
 *            apps/backend/ingestion-data/scripts/publish_incremental_batch.py.
 *
 * USO (a partir de apps/backend/api/loadtest/k6)
 *   export BASE_URL=<api_url_https> AUTH_USERNAME=<email> AUTH_PASSWORD=<senha>
 *   k6 run -e MODE=smoke    -e DUMP=<M-01> -e EXPECTED_EVENTS=<n> ingestao-batch.js
 *   k6 run -e MODE=drenagem -e DUMP=<M-02> -e EXPECTED_EVENTS=150000 -e RUN_LABEL=cg02-r1 ingestao-batch.js
 *   k6 run -e MODE=pico     -e DUMP=<M-01> -e PEAK_RATE=50 ingestao-batch.js
 *   k6 run -e MODE=limite   -e DUMP=<M-01> -e BURST_RATE=20 ingestao-batch.js
 *   k6 run -e MODE=frescor  -e T0=<ISO> -e EXPECT_OBSERVED_THROUGH=<ISO> ingestao-batch.js
 *
 * A versão do dataset é endereçada por conteúdo: reimportar um dump já
 * importado termina em READY com recordsRead = recordsWritten = 0. Nas
 * rodadas de recuperação que reutilizam o mesmo DUMP, passe
 * -e ALLOW_IDEMPOTENT=true: o teste passa a exigir esse resultado (0 lidos,
 * 0 escritos, 0 rejeitados e a versão existente reaproveitada; com
 * -e EXPECTED_VERSION=<dsv_…> confere também qual versão). Sem a flag, vale a
 * contagem normal de EXPECTED_EVENTS.
 *
 * Sem AUTH_USERNAME/AUTH_PASSWORD, cai para o cookie forjado de
 * lib/session.js (exige AUTH_COOKIE_SECRET), útil só contra a API local.
 */

import http from "k6/http";
import crypto from "k6/crypto";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { forgeSessionCookie, loginSessionCookie, requestIdHeader } from "./lib/session.js";
import { controlResponseMatches, hasRecordProgress, isImportConflict, isRateLimited } from "./lib/ingestion-contract.mjs";

const BASE_URL = __ENV.BASE_URL;
const MODE = __ENV.MODE || "smoke";
const MODES = ["smoke", "drenagem", "pico", "limite", "frescor"];
const RUN_LABEL = __ENV.RUN_LABEL || MODE;
const PART_SIZE = 16 * 1024 * 1024; // igual a PART_SIZE da API
const SIGN_WINDOW = 20; // máximo de partes por POST /parts
const FILE_NAME = "argus_dump.sql.gz"; // único nome .sql.gz aceito pelo contrato
const SNAPSHOT_EXTRACTED_ON = __ENV.SNAPSHOT_EXTRACTED_ON || new Date().toISOString().slice(0, 10);
const EXPECTED_EVENTS = __ENV.EXPECTED_EVENTS ? Number(__ENV.EXPECTED_EVENTS) : null;
const WINDOW_SECONDS = Number(__ENV.WINDOW_SECONDS || 900); // janela de 15 min
const NOMINAL_EVENTS_PER_SECOND = 10000 / 60; // 166,67 eventos/s (RNF01)
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 5);
const POLL_TIMEOUT_S = Number(__ENV.POLL_TIMEOUT_S || 3600);
const ACTIVATE = __ENV.ACTIVATE === "true";
const ALLOW_IDEMPOTENT = __ENV.ALLOW_IDEMPOTENT === "true";
const EXPECTED_VERSION = __ENV.EXPECTED_VERSION || null; // dsv_… da importação original
const PEAK_RATE = Number(__ENV.PEAK_RATE || 50);
const BURST_RATE = Number(__ENV.BURST_RATE || 20);
const COOLDOWN_S = Number(__ENV.COOLDOWN_S || 60);

if (!BASE_URL) throw new Error("Faltou -e BASE_URL=<url da API>");
if (!MODES.includes(MODE)) throw new Error(`MODE inválido. Use: ${MODES.join(", ")}`);
for (const [name, value] of Object.entries({ WINDOW_SECONDS, POLL_INTERVAL_S, POLL_TIMEOUT_S, PEAK_RATE, BURST_RATE, COOLDOWN_S })) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser positivo e finito`);
}
if (EXPECTED_EVENTS !== null && (!Number.isSafeInteger(EXPECTED_EVENTS) || EXPECTED_EVENTS < 1)) {
  throw new Error("EXPECTED_EVENTS deve ser um inteiro positivo");
}
if (MODE === "drenagem" && (EXPECTED_EVENTS === null || ALLOW_IDEMPOTENT)) {
  throw new Error("MODE=drenagem exige EXPECTED_EVENTS e um dump novo; reimportação idempotente não mede capacidade");
}
if (ALLOW_IDEMPOTENT && !EXPECTED_VERSION) {
  throw new Error("ALLOW_IDEMPOTENT exige EXPECTED_VERSION para conferir a versão reaproveitada");
}

// open() só funciona no contexto de inicialização; o arquivo é lido uma vez
// por VU. Os modos de rajada usam o DUMP apenas no teardown.
const NEEDS_DUMP = MODE !== "frescor";
if (NEEDS_DUMP && !__ENV.DUMP) throw new Error(`MODE=${MODE} exige -e DUMP=<caminho do argus_dump.sql.gz>`);
const DUMP = NEEDS_DUMP ? open(__ENV.DUMP, "b") : null;

if (MODE === "frescor" && (!__ENV.T0 || !__ENV.EXPECT_OBSERVED_THROUGH)) {
  throw new Error("MODE=frescor exige -e T0=<ISO da publicação> e -e EXPECT_OBSERVED_THROUGH=<ISO do fim da janela>");
}
if (MODE === "frescor" && [__ENV.T0, __ENV.EXPECT_OBSERVED_THROUGH].some((value) => !Number.isFinite(Date.parse(value)))) {
  throw new Error("T0 e EXPECT_OBSERVED_THROUGH devem ser timestamps ISO válidos");
}

// ---------------------------------------------------------------- métricas
const stateSeconds = new Trend("ingestion_state_seconds", true); // tag: state
const uploadSeconds = new Trend("ingestion_upload_seconds", true);
// UPLOADED → estado final. Também recebe amostra quando a importação não chega
// a READY (tempo até FAILED ou até o POLL_TIMEOUT_S): um Trend sem amostra
// faria o threshold passar com valor 0.
const processingSeconds = new Trend("ingestion_processing_seconds", true);
const totalSeconds = new Trend("ingestion_total_seconds", true); // POST /imports → READY
const eventsPerSecond = new Trend("ingestion_events_per_second"); // 0 quando não chega a READY
const importsReady = new Rate("ingestion_ready_rate");
const recordsWritten = new Counter("ingestion_records_written");
const recordsRejected = new Counter("ingestion_records_rejected");
const importsCreated = new Counter("imports_created_201");
const importsConflict = new Counter("imports_conflict_409");
const rateLimited = new Counter("rate_limited_429");
const explicit503 = new Counter("explicit_503");
const unexpected5xx = new Counter("unexpected_5xx");
const recovery2xx = new Rate("recovery_2xx_rate");
const firstOkAfterBurst = new Trend("time_to_first_2xx_after_burst_seconds", true);
const freshnessSeconds = new Trend("ingestion_end_to_end_freshness_seconds", true);

// ------------------------------------------------------------------ opções
const baseThresholds = { checks: ["rate==1"] };

function scenariosFor(mode) {
  if (mode === "pico") {
    return {
      pico: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: Math.max(10, PEAK_RATE),
        maxVUs: Math.max(50, PEAK_RATE * 4),
        stages: [
          { target: PEAK_RATE, duration: "30s" },
          { target: PEAK_RATE, duration: "2m" },
          { target: 0, duration: "30s" },
        ],
      },
    };
  }
  if (mode === "limite") {
    const phase = (name, rate, start, duration) => ({
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      startTime: start,
      preAllocatedVUs: Math.max(5, rate),
      maxVUs: Math.max(20, rate * 4),
      tags: { fase: name },
      env: { FASE: name },
    });
    return {
      nominal: phase("nominal", 1, "0s", "60s"),
      rajada: phase("rajada", BURST_RATE, "60s", "60s"),
      resfriamento: phase("resfriamento", 1, "120s", `${COOLDOWN_S}s`),
      recuperacao: phase("recuperacao", 1, `${120 + COOLDOWN_S}s`, "60s"),
    };
  }
  return {
    [mode]: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: `${POLL_TIMEOUT_S + 600}s` },
  };
}

function thresholdsFor(mode) {
  if (mode === "smoke") return { ...baseThresholds, http_req_failed: ["rate==0"], ingestion_ready_rate: ["rate==1"] };
  if (mode === "drenagem") {
    return {
      ...baseThresholds,
      http_req_failed: ["rate==0"],
      ingestion_ready_rate: ["rate==1"],
      ingestion_processing_seconds: [`max<=${WINDOW_SECONDS}`],
      ingestion_events_per_second: [`min>=${NOMINAL_EVENTS_PER_SECOND.toFixed(2)}`],
    };
  }
  if (mode === "pico") {
    return {
      ...baseThresholds,
      imports_created_201: ["count==1"],
      unexpected_5xx: ["count==0"],
      dropped_iterations: ["count==0"],
      "http_req_duration{metodo:GET}": ["p(95)<2000"],
    };
  }
  if (mode === "limite") {
    return {
      ...baseThresholds,
      unexpected_5xx: ["count==0"],
      imports_created_201: ["count==0"],
      "rate_limited_429{fase:rajada}": ["count>0"],
      dropped_iterations: ["count==0"],
      recovery_2xx_rate: ["rate==1"],
    };
  }
  return { ...baseThresholds, ingestion_end_to_end_freshness_seconds: ["max<=120"] };
}

export const options = {
  scenarios: scenariosFor(MODE),
  thresholds: thresholdsFor(MODE),
  setupTimeout: "10m",
  teardownTimeout: `${POLL_TIMEOUT_S + 600}s`,
};

// 409 e 429 são respostas corretas nos modos de rajada; não contam como erro.
http.setResponseCallback(
  MODE === "pico" || MODE === "limite"
    ? http.expectedStatuses({ min: 200, max: 299 }, 409, 429)
    : http.expectedStatuses({ min: 200, max: 299 }),
);

// ---------------------------------------------------------------- auxiliares
function authenticate() {
  if (__ENV.AUTH_USERNAME && __ENV.AUTH_PASSWORD) {
    return loginSessionCookie(BASE_URL, __ENV.AUTH_USERNAME, __ENV.AUTH_PASSWORD);
  }
  return forgeSessionCookie({ role: "engineer" });
}

function params(cookie, name, extraHeaders = {}) {
  return {
    headers: {
      Cookie: `session=${cookie}`,
      "Content-Type": "application/json",
      ...requestIdHeader(`k6-ingestao-${MODE}`),
      ...extraHeaders,
    },
    tags: { name, metodo: name.split(" ")[0] },
  };
}

function idempotencyKey(action) {
  return `k6-${RUN_LABEL}-${action}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function json(res, path) {
  try {
    return res.json(path);
  } catch {
    return undefined;
  }
}

function track(res) {
  if (res.status === 409) importsConflict.add(1);
  if (res.status === 429) rateLimited.add(1, { fase: __ENV.FASE || "fora-do-cenario" });
  // Falha explícita é um diagnóstico, não disponibilidade: nenhum modo aqui
  // injeta falha de servidor, portanto todo 5xx reprova o plano de controle.
  if (res.status === 503 && ["FEATURE_UNAVAILABLE", "UPLOAD_PREPARATION_FAILED"].includes(json(res, "error.code"))) explicit503.add(1);
  if (res.status >= 500) unexpected5xx.add(1);
}

function startImport(cookie, sizeBytes, { count = true } = {}) {
  const res = http.post(
    `${BASE_URL}/api/v1/imports`,
    JSON.stringify({ fileName: FILE_NAME, sizeBytes, snapshotExtractedOn: SNAPSHOT_EXTRACTED_ON }),
    params(cookie, "POST /imports", { "Idempotency-Key": idempotencyKey("start") }),
  );
  if (count) {
    track(res);
    if (res.status === 201) importsCreated.add(1);
  }
  return res;
}

function getImport(cookie, importId) {
  const res = http.get(`${BASE_URL}/api/v1/imports/${importId}`, params(cookie, "GET /imports/:id"));
  track(res);
  return res;
}

/** Espera sair de PREPARING (a API normalmente já responde em UPLOADING). */
function waitUploading(cookie, importId) {
  const deadline = Date.now() + 120 * 1000;
  while (Date.now() < deadline) {
    const state = json(getImport(cookie, importId), "data.state");
    if (state === "UPLOADING") return true;
    if (state === "FAILED") return false;
    sleep(1);
  }
  return false;
}

/** Assina, envia e confirma todas as partes do DUMP. Devolve a resposta do complete. */
function uploadAndComplete(cookie, importId) {
  const total = DUMP.byteLength;
  const partCount = Math.ceil(total / PART_SIZE);
  const manifest = [];
  const t0 = Date.now();
  for (let first = 1; first <= partCount; first += SIGN_WINDOW) {
    const window = [];
    for (let n = first; n < first + SIGN_WINDOW && n <= partCount; n += 1) {
      const body = DUMP.slice((n - 1) * PART_SIZE, Math.min(n * PART_SIZE, total));
      window.push({ partNumber: n, body, checksumSha256: crypto.sha256(body, "base64") });
    }
    const signed = http.post(
      `${BASE_URL}/api/v1/imports/${importId}/parts`,
      JSON.stringify({ parts: window.map(({ partNumber, checksumSha256 }) => ({ partNumber, checksumSha256 })) }),
      params(cookie, "POST /imports/:id/parts"),
    );
    track(signed);
    if (!check(signed, { "partes assinadas (200)": (r) => r.status === 200 })) return null;
    const urls = new Map((json(signed, "data.parts") || []).map((p) => [p.partNumber, p]));
    for (const part of window) {
      const target = urls.get(part.partNumber);
      if (!target) throw new Error(`A API não assinou a parte ${part.partNumber}`);
      const put = http.put(target.url, part.body, { headers: target.headers, tags: { name: "PUT parte S3", metodo: "PUT" } });
      const etag = put.headers.Etag || put.headers.ETag || put.headers.etag;
      if (!check(put, { "parte enviada ao S3 com ETag": (r) => r.status === 200 && Boolean(etag) })) return null;
      manifest.push({ partNumber: part.partNumber, etag, checksumSha256: part.checksumSha256 });
    }
  }
  uploadSeconds.add((Date.now() - t0) / 1000);
  const completed = http.post(
    `${BASE_URL}/api/v1/imports/${importId}/complete`,
    JSON.stringify({ parts: manifest }),
    params(cookie, "POST /imports/:id/complete", { "Idempotency-Key": idempotencyKey("complete") }),
  );
  track(completed);
  check(completed, { "complete aceito (202)": (r) => r.status === 202 });
  return completed;
}

/**
 * Faz polling até READY/FAILED registrando quanto tempo cada estado durou e
 * o último progresso observado. Devolve { state, progress, error, since }.
 */
function waitTerminal(cookie, importId) {
  const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
  let current = null;
  let enteredAt = Date.now();
  const enteredState = {};
  let last = null;
  while (Date.now() < deadline) {
    const res = getImport(cookie, importId);
    const data = json(res, "data");
    if (data && data.state !== current) {
      const now = Date.now();
      if (current) stateSeconds.add((now - enteredAt) / 1000, { state: current });
      current = data.state;
      enteredAt = now;
      enteredState[current] = now;
    }
    last = data || last;
    if (current === "READY" || current === "FAILED") break;
    sleep(POLL_INTERVAL_S);
  }
  return {
    state: current,
    progress: last && last.progress,
    error: last && last.error,
    candidateVersion: last && last.candidateVersion,
    enteredState,
  };
}

/** Importação completa de ponta a ponta com o DUMP. Usada por smoke, drenagem e teardowns. */
function runImport(cookie, label) {
  const t0 = Date.now();
  const started = startImport(cookie, DUMP.byteLength);
  if (!check(started, { [`${label}: importação criada (201)`]: (r) => r.status === 201 })) {
    console.error(`${label}: POST /imports → ${started.status} ${started.body}`);
    return null;
  }
  const importId = json(started, "data.importId");
  if (!waitUploading(cookie, importId)) {
    check(null, { [`${label}: importação chegou a UPLOADING`]: () => false });
    return { importId };
  }
  return finishImport(cookie, importId, label, t0);
}

function finishImport(cookie, importId, label, t0 = Date.now()) {
  const completed = uploadAndComplete(cookie, importId);
  if (!completed || completed.status !== 202) return { importId };
  const uploadedAt = Date.now();
  const result = waitTerminal(cookie, importId);
  const ok = check(result, { [`${label}: importação terminou em READY`]: (r) => r.state === "READY" });
  if (!ok) console.error(`${label}: estado final ${result.state} ${JSON.stringify(result.error)}`);
  const processing = (Date.now() - uploadedAt) / 1000;
  processingSeconds.add(processing);
  importsReady.add(ok);
  if (!ok) eventsPerSecond.add(0);
  if (result.state === "READY") {
    totalSeconds.add((Date.now() - t0) / 1000);
    const progress = result.progress;
    const validProgress = check(progress, {
      [`${label}: READY contém contadores de registros válidos`]: hasRecordProgress,
    });
    if (!validProgress) {
      eventsPerSecond.add(0);
      return { importId, ...result };
    }
    if (ALLOW_IDEMPOTENT) {
      // O DUMP já foi importado: a versão existente é reaproveitada e nada é
      // lido, escrito ou rejeitado de novo. Vazão não se aplica.
      check(result, {
        [`${label}: reimportação idempotente não escreveu nenhum item`]: () =>
          Boolean(progress) && progress.recordsRead === 0 && progress.recordsWritten === 0,
        [`${label}: reimportação idempotente não rejeitou nenhum item`]: () =>
          Boolean(progress) && progress.recordsRejected === 0,
        [`${label}: reimportação idempotente reaproveitou a versão existente, sem duplicar`]: (r) =>
          Boolean(r.candidateVersion) && (!EXPECTED_VERSION || r.candidateVersion === EXPECTED_VERSION),
      });
      if (EXPECTED_EVENTS !== null) {
        check(progress, {
          [`${label}: recordsTotal = ${EXPECTED_EVENTS}`]: (p) => Boolean(p) && p.recordsTotal === EXPECTED_EVENTS,
        });
      }
    } else {
      recordsWritten.add(progress.recordsWritten);
      recordsRejected.add(progress.recordsRejected);
      eventsPerSecond.add(progress.recordsWritten / processing);
      check(progress, { [`${label}: nenhum evento rejeitado`]: (p) => p.recordsRejected === 0 });
      if (EXPECTED_EVENTS !== null) {
        check(progress, {
          [`${label}: recordsWritten = ${EXPECTED_EVENTS}`]: (p) => p.recordsWritten === EXPECTED_EVENTS,
        });
      }
    }
    if (ACTIVATE) {
      const activated = http.post(
        `${BASE_URL}/api/v1/imports/${importId}/activate`,
        "{}",
        params(cookie, "POST /imports/:id/activate", { "Idempotency-Key": idempotencyKey("activate") }),
      );
      check(activated, { [`${label}: dataset ativado (200)`]: (r) => r.status === 200 });
    }
  }
  return { importId, ...result };
}

/** Descobre a importação ativa, se houver, provocando um 409. Fora das métricas do teste. */
function activeImportId(cookie) {
  const res = startImport(cookie, DUMP.byteLength, { count: false });
  if (res.status === 201) return { importId: json(res, "data.importId"), createdByUs: true };
  if (isImportConflict(res)) return { importId: json(res, "error.details.importId"), createdByUs: false };
  throw new Error(`Não foi possível descobrir a importação ativa: ${res.status} ${res.body}`);
}

// ------------------------------------------------------------------ ciclo
export function setup() {
  const cookie = authenticate();
  if (MODE === "limite") {
    // Pré-condição do RS-06: uma importação ativa durante a rajada.
    const { importId, createdByUs } = activeImportId(cookie);
    return { cookie, importId, createdByUs };
  }
  return { cookie, startedAt: Date.now() };
}

let pico = { importId: null };
let firstOkSeen = false;

export default function (data) {
  const cookie = data.cookie;

  if (MODE === "smoke" || MODE === "drenagem") {
    runImport(cookie, RUN_LABEL);
    return;
  }

  if (MODE === "pico") {
    const roll = Math.random();
    if (roll < 0.2 || !pico.importId) {
      const res = startImport(cookie, DUMP.byteLength);
      check(res, { "pico: POST cria importação ou identifica a trava ativa": (r) =>
        (r.status === 201 && typeof json(r, "data.importId") === "string") || isImportConflict(r),
      });
      pico.importId = json(res, "data.importId") || json(res, "error.details.importId") || pico.importId;
      if (res.status === 409) {
        check(res, { "pico: 409 traz o importId ativo": (r) => Boolean(json(r, "error.details.importId")) });
      }
    } else if (roll < 0.9) {
      check(getImport(cookie, pico.importId), { "pico: GET /imports/:id 200": (r) => r.status === 200 });
    } else {
      const res = http.get(`${BASE_URL}/api/v1/imports?limit=10`, params(cookie, "GET /imports"));
      track(res);
      check(res, { "pico: GET /imports 200": (r) => r.status === 200 });
    }
    return;
  }

  if (MODE === "limite") {
    const fase = __ENV.FASE;
    // 80% leitura, 20% tentativa de criar outra importação (deve dar 409 ou 429).
    const method = Math.random() < 0.2 ? "POST" : "GET";
    const res = method === "POST"
      ? startImport(cookie, DUMP.byteLength)
      : getImport(cookie, data.importId);
    // Na recuperação, 409 IMPORT_IN_PROGRESS é a resposta correta do POST.
    const answered = controlResponseMatches(res, method, "recuperacao", data.importId);
    if (fase === "recuperacao") recovery2xx.add(answered);
    if (fase === "resfriamento" && answered && !firstOkSeen) {
      // O resfriamento começa no fim da rajada; o menor valor da métrica é o
      // tempo até a API voltar a responder.
      firstOkSeen = true;
      firstOkAfterBurst.add((Date.now() - exec.scenario.startTime) / 1000);
    }
    check(res, { "limite: resposta corresponde à rota e à fase": (r) =>
      controlResponseMatches(r, method, fase, data.importId),
    });
    if (res.status === 429) check(res, { "limite: 429 é RATE_LIMITED": isRateLimited });
    return;
  }

  if (MODE === "frescor") {
    const t0 = Date.parse(__ENV.T0);
    const expected = Date.parse(__ENV.EXPECT_OBSERVED_THROUGH);
    const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      const res = http.get(`${BASE_URL}/api/v1/dashboard/overview`, params(cookie, "GET /dashboard/overview"));
      const observed = (json(res, "meta.freshness") || [])
        .map((entry) => Date.parse(entry.observedThrough))
        .filter((value) => !Number.isNaN(value));
      if (res.status === 200 && observed.some((value) => value >= expected)) {
        freshnessSeconds.add((Date.now() - t0) / 1000);
        check(null, { "frescor: lote visível na consulta": () => true });
        return;
      }
      sleep(POLL_INTERVAL_S);
    }
    check(null, { "frescor: lote visível na consulta": () => false });
  }
}

export function teardown(data) {
  // Libera a vaga: conclui a importação que ficou em UPLOADING.
  if (MODE !== "pico" && MODE !== "limite") return;
  const cookie = data.cookie;
  let importId = data.importId;
  // Uma importação preexistente pode pertencer a outra operação; só finaliza
  // aquela reservada por este teste. O pico a identifica por canManageUpload.
  if (MODE === "limite" && !data.createdByUs) return;
  if (MODE === "pico") {
    const res = http.get(`${BASE_URL}/api/v1/imports?limit=20`, params(cookie, "GET /imports"));
    const items = json(res, "data.items") || [];
    const active = items.find((item) =>
      item.state === "UPLOADING" && item.canManageUpload &&
      Number.isFinite(data.startedAt) && Date.parse(item.createdAt) >= data.startedAt,
    );
    importId = active && active.importId;
  }
  if (!importId) return;
  const state = json(getImport(cookie, importId), "data.state");
  if (state === "UPLOADING") {
    console.log(`teardown: concluindo ${importId} com o DUMP para liberar a vaga`);
    finishImport(cookie, importId, `${MODE}-limpeza`);
  }
}

/** Resumo de texto: checks, thresholds e métricas do teste (o JSON completo vai para o arquivo). */
function textSummary(data) {
  const lines = [`Ingestão — modo ${MODE} (${RUN_LABEL})`];
  const checks = [];
  const collect = (group) => {
    checks.push(...(group.checks || []));
    (group.groups || []).forEach(collect);
  };
  collect(data.root_group || {});
  if (checks.length) lines.push("", "checks");
  for (const item of checks) {
    lines.push(`  ${item.fails === 0 ? "ok    " : "FALHOU"} ${item.name} (${item.passes}/${item.passes + item.fails})`);
  }
  const metrics = data.metrics || {};
  const number = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
  const values = (metric) => Object.entries(metric.values).map(([key, value]) => `${key}=${number(value)}`).join(" ");
  const withThresholds = Object.keys(metrics).filter((name) => metrics[name].thresholds);
  if (withThresholds.length) lines.push("", "thresholds");
  for (const name of withThresholds) {
    for (const [rule, result] of Object.entries(metrics[name].thresholds)) {
      lines.push(`  ${result.ok ? "ok    " : "FALHOU"} ${name} ${rule}  [${values(metrics[name])}]`);
    }
  }
  const own = Object.keys(metrics)
    .filter((name) => /^(ingestion_|imports_|rate_limited_|explicit_|unexpected_|recovery_|time_to_)/.test(name))
    .concat(["http_reqs", "http_req_failed", "http_req_duration"].filter((name) => metrics[name]))
    .filter((name) => !withThresholds.includes(name));
  if (own.length) lines.push("", "métricas");
  for (const name of own) lines.push(`  ${name}  ${values(metrics[name])}`);
  return `${lines.join("\n")}\n`;
}

export function handleSummary(data) {
  const semCredenciais = {
    ...data,
    test_config: {
      mode: MODE, runLabel: RUN_LABEL, expectedEvents: EXPECTED_EVENTS,
      expectedVersion: EXPECTED_VERSION, allowIdempotent: ALLOW_IDEMPOTENT,
      windowSeconds: WINDOW_SECONDS, pollTimeoutSeconds: POLL_TIMEOUT_S,
      peakRate: PEAK_RATE, burstRate: BURST_RATE,
      dumpSha256: DUMP ? crypto.sha256(DUMP, "hex") : null,
    },
    setup_data: data.setup_data ? { ...data.setup_data, cookie: "<redigido>" } : data.setup_data,
  };
  return {
    stdout: textSummary(data),
    [`resumo-ingestao-${RUN_LABEL}.json`]: JSON.stringify(semCredenciais, null, 2),
  };
}

/**
 * Carga e resiliência da API Flask de ingestão de telemetria.
 *
 * Alvo: apps/basica/backend, POST /v1/telemetry/events.
 * Carga padrão: 100 lotes/min × 100 eventos/lote = 10.000 eventos/min.
 *
 * Modos:
 *   carga       — 10 mil eventos/min por 1 minuto;
 *   fila_cheia  — baseline, 429 queue_full induzido e recuperação;
 *   timeout     — baseline, 504 dependency_timeout induzido e recuperação.
 *
 * As falhas exigem LOAD_TEST_FAULTS_ENABLED=1 e LOAD_TEST_FAULT_TOKEN no
 * servidor. O mesmo token deve ser informado ao k6 por FAULT_TOKEN.
 */

import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const MODE = __ENV.MODE || "carga";
const EVENT_RATE = Number(__ENV.EVENT_RATE || 10000);
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 100);
const REQUEST_RATE = EVENT_RATE / BATCH_SIZE;
const FAULT_TOKEN = __ENV.FAULT_TOKEN || "";

if (!BASE_URL) throw new Error("Faltou -e BASE_URL=http://<host>");
if (!Number.isInteger(EVENT_RATE) || EVENT_RATE <= 0) {
  throw new Error("EVENT_RATE deve ser um inteiro positivo");
}
if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE <= 0 || BATCH_SIZE > 500) {
  throw new Error("BATCH_SIZE deve ser um inteiro entre 1 e 500");
}
if (!Number.isInteger(REQUEST_RATE)) {
  throw new Error("EVENT_RATE deve ser divisível por BATCH_SIZE para manter a taxa exata");
}
if (!["carga", "fila_cheia", "timeout"].includes(MODE)) {
  throw new Error("MODE inválido. Use carga, fila_cheia ou timeout");
}
if (MODE !== "carga" && !FAULT_TOKEN) {
  throw new Error("FAULT_TOKEN é obrigatório nos modos fila_cheia e timeout");
}

const eventosTentados = new Counter("ingestion_events_attempted");
const eventosAceitos = new Counter("ingestion_events_accepted");
const eventosRecusadosEsperados = new Counter("ingestion_events_expected_rejection");
const latenciaIngestao = new Trend("ingestion_duration_ms", true);

function arrivalScenario(name, duration, startTime = "0s") {
  return {
    executor: "constant-arrival-rate",
    exec: name,
    rate: REQUEST_RATE,
    timeUnit: "1m",
    duration,
    startTime,
    preAllocatedVUs: 20,
    maxVUs: 200,
  };
}

const scenarioSets = {
  carga: {
    carga: arrivalScenario("ingestirNormal", "1m"),
  },
  fila_cheia: {
    baseline: arrivalScenario("ingestirNormal", "30s"),
    falha_fila: arrivalScenario("simularFilaCheia", "30s", "30s"),
    recuperacao: arrivalScenario("ingestirNormal", "1m", "1m"),
  },
  timeout: {
    baseline: arrivalScenario("ingestirNormal", "30s"),
    falha_timeout: arrivalScenario("simularTimeout", "30s", "30s"),
    recuperacao: arrivalScenario("ingestirNormal", "1m", "1m"),
  },
};

const successThresholds = {
  http_req_failed: ["rate<0.01"],
  "checks{phase:normal}": ["rate==1"],
  "ingestion_duration_ms{phase:normal}": ["p(95)<2000"],
  dropped_iterations: ["count==0"],
};

export const options = {
  scenarios: scenarioSets[MODE],
  thresholds: MODE === "carga"
    ? {
        ...successThresholds,
        ingestion_events_accepted: [`count>=${EVENT_RATE}`],
      }
    : {
        http_req_failed: ["rate<0.01"],
        "checks{phase:fault}": ["rate==1"],
        "checks{phase:normal}": ["rate==1"],
        "checks{phase:recovery}": ["rate==1"],
        "ingestion_duration_ms{phase:normal}": ["p(95)<2000"],
        "ingestion_duration_ms{phase:recovery}": ["p(95)<2000"],
        "ingestion_events_accepted{phase:recovery}": [`count>=${EVENT_RATE}`],
        dropped_iterations: ["count==0"],
      },
};

// 429 e 504 são respostas esperadas exclusivamente durante as fases de falha.
// Os checks por fase garantem que elas não sejam confundidas com sucesso.
http.setResponseCallback(http.expectedStatuses(200, 202, 429, 504));

export function setup() {
  const preflight = http.get(`${BASE_URL}/v1/analytics/realtime/overview`);
  if (preflight.status !== 200) {
    throw new Error(`Pré-voo falhou: HTTP ${preflight.status} em ${BASE_URL}`);
  }
}

function payload() {
  const now = new Date().toISOString();
  const iteration = exec.scenario.iterationInTest;
  return Array.from({ length: BATCH_SIZE }, (_, index) => ({
    session_id: `k6-${MODE}-${exec.vu.idInTest}-${iteration}-${index}`,
    event_type: "playback_start",
    timestamp: now,
    startup_time_ms: 800 + (index % 20) * 25,
    rebuffer_duration_ms: index % 10 === 0 ? 250 : 0,
    rebuffer_count: index % 10 === 0 ? 1 : 0,
    playback_duration_ms: 60_000,
    bitrate_kbps: 4_500,
    device: { model: "k6-device", os: "test", app_version: "load-1" },
    network: { isp: "k6", cdn: "test-cdn", connection_type: "ethernet" },
  }));
}

function enviar(fault, phase) {
  const body = JSON.stringify(payload());
  const headers = { "Content-Type": "application/json" };
  if (fault) {
    headers["X-View-Show-Test-Fault"] = fault;
    headers["X-View-Show-Test-Token"] = FAULT_TOKEN;
  }

  eventosTentados.add(BATCH_SIZE, { phase });
  const response = http.post(`${BASE_URL}/v1/telemetry/events`, body, {
    headers,
    tags: { phase, fault: fault || "none", name: "POST /v1/telemetry/events" },
    timeout: "10s",
  });
  latenciaIngestao.add(response.timings.duration, { phase });

  if (!fault) {
    let accepted = 0;
    try { accepted = Number(response.json("accepted") || 0); } catch { accepted = 0; }
    eventosAceitos.add(accepted, { phase });
    check(
      response,
      {
        "ingestão normal retorna 202": (r) => r.status === 202,
        "ingestão normal aceita o lote inteiro": () => accepted === BATCH_SIZE,
      },
      { phase, trecho: phase },
    );
    return;
  }

  eventosRecusadosEsperados.add(BATCH_SIZE, { phase: "fault", fault });
  const expected = fault === "queue-full"
    ? { status: 429, code: "queue_full" }
    : { status: 504, code: "dependency_timeout" };
  check(
    response,
    {
      [`${fault}: status ${expected.status}`]: (r) => r.status === expected.status,
      [`${fault}: código ${expected.code}`]: (r) => {
        try { return r.json("error.code") === expected.code; } catch { return false; }
      },
    },
    { phase: "fault", fault },
  );
}

export function ingestirNormal() {
  const phase = exec.scenario.name === "recuperacao" ? "recovery" : "normal";
  enviar(null, phase);
}

export function simularFilaCheia() {
  enviar("queue-full", "fault");
}

export function simularTimeout() {
  enviar("timeout", "fault");
}

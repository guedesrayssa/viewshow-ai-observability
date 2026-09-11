import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  parseAnalysisEvent,
  analysisRunId,
  SUPPORTED_SCHEMA_VERSION,
  type EventParseResult,
} from "../src/contracts/analysis-event.js";

/** Exemplo de `analise-e-ia.md` §4.1, usado como base de todos os casos. */
const ANOMALIA = {
  eventId: "evt_01K2F8BAYX",
  eventType: "ANOMALY_DETECTION",
  schemaVersion: "1.0",
  idempotencyKey: "ana_01K2F8BAYX",
  traceId: "trc_01K2F8BAYX",
  occurredAt: "2026-09-06T15:00:00.000Z",
  producedAt: "2026-09-06T15:01:12.000Z",
  source: "data-ingestion-service",
  payload: {
    window: { start: "2026-09-06T14:45:00.000Z", end: "2026-09-06T15:00:00.000Z", grainSeconds: 900 },
    scope: { kind: "global", dimensions: {} },
    inputWatermark: "2026-09-06T15:00:00.000Z",
    datasetVersion: "dsv_01K2F8BAYX",
  },
};

/** Exemplo de §4.3. Reanálise não é evento de janela. */
const REANALISE = {
  eventId: "evt_01K2F8BAYX",
  eventType: "REANALYSIS_REQUESTED",
  schemaVersion: "1.0",
  idempotencyKey: "rea_01K2F8BAYX",
  traceId: "trc_01K2F8BAYX",
  occurredAt: "2026-09-06T15:30:00.000Z",
  producedAt: "2026-09-06T15:30:00.000Z",
  source: "backend-api",
  payload: { incidentId: "inc_01K2F8BAYX", requestedBy: "usr_01K2F8BAYX", reason: "MANUAL_REQUEST" },
};

function codigos(r: EventParseResult): readonly string[] {
  return r.ok ? [] : r.metadata.failures.map((f) => f.code);
}

function semCampo(objeto: Record<string, unknown>, campo: string) {
  const copia = { ...objeto };
  delete copia[campo];
  return copia;
}

test("aceita o evento de detecção do documento sem alteração", () => {
  const r = parseAnalysisEvent(ANOMALIA);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.event.eventType, "ANOMALY_DETECTION");
});

test("aceita o evento de reanálise do documento sem alteração", () => {
  assert.ok(parseAnalysisEvent(REANALISE).ok);
});

test("mensagem que não é objeto é erro permanente", () => {
  const r = parseAnalysisEvent("não sou objeto");
  assert.deepEqual(codigos(r), ["NOT_AN_OBJECT"]);
  assert.ok(!r.ok && r.permanent);
});

test("todo campo obrigatório do envelope é cobrado", () => {
  for (const campo of ["eventId", "eventType", "schemaVersion", "idempotencyKey", "traceId", "occurredAt", "producedAt"]) {
    const r = parseAnalysisEvent(semCampo(ANOMALIA, campo));
    assert.ok(codigos(r).includes("MISSING_FIELD"), `${campo} deveria ser cobrado`);
  }
});

test("versão de contrato diferente é erro permanente, não aviso", () => {
  const r = parseAnalysisEvent({ ...ANOMALIA, schemaVersion: "2.0" });
  assert.deepEqual(codigos(r), ["UNSUPPORTED_SCHEMA_VERSION"]);
});

test("tipo de evento desconhecido é rejeitado", () => {
  const r = parseAnalysisEvent({ ...ANOMALIA, eventType: "ALGO_NOVO" });
  assert.ok(codigos(r).includes("UNKNOWN_EVENT_TYPE"));
});

test("evento de janela sem watermark ou versão de dataset é rejeitado", () => {
  for (const campo of ["inputWatermark", "datasetVersion"]) {
    const r = parseAnalysisEvent({ ...ANOMALIA, payload: semCampo(ANOMALIA.payload, campo) });
    assert.ok(codigos(r).includes("MISSING_FIELD"), `payload.${campo} deveria ser cobrado`);
  }
});

test("janela invertida é rejeitada — existir campo não é o mesmo que ser válida", () => {
  const r = parseAnalysisEvent({
    ...ANOMALIA,
    payload: { ...ANOMALIA.payload, window: { start: "2026-09-06T15:00:00.000Z", end: "2026-09-06T14:45:00.000Z", grainSeconds: 900 } },
  });
  assert.deepEqual(codigos(r), ["INVALID_WINDOW"]);
});

test("janela de duração zero é rejeitada", () => {
  const instante = "2026-09-06T15:00:00.000Z";
  const r = parseAnalysisEvent({
    ...ANOMALIA,
    payload: { ...ANOMALIA.payload, window: { start: instante, end: instante, grainSeconds: 900 } },
  });
  assert.deepEqual(codigos(r), ["INVALID_WINDOW"]);
});

test("grão não positivo é rejeitado", () => {
  const r = parseAnalysisEvent({
    ...ANOMALIA,
    payload: { ...ANOMALIA.payload, window: { ...ANOMALIA.payload.window, grainSeconds: 0 } },
  });
  assert.deepEqual(codigos(r), ["INVALID_WINDOW"]);
});

test("instante malformado é rejeitado", () => {
  const r = parseAnalysisEvent({ ...ANOMALIA, occurredAt: "ontem à tarde" });
  assert.deepEqual(codigos(r), ["INVALID_TIMESTAMP"]);
});

test("reanálise não exige janela, mas exige incidente e solicitante", () => {
  for (const campo of ["incidentId", "requestedBy", "reason"]) {
    const r = parseAnalysisEvent({ ...REANALISE, payload: semCampo(REANALISE.payload, campo) });
    assert.ok(codigos(r).includes("MISSING_FIELD"), `payload.${campo} deveria ser cobrado`);
  }
});

test("metadados de falha levam identificadores e nenhum payload", () => {
  const r = parseAnalysisEvent({ ...ANOMALIA, schemaVersion: "9.9" });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.metadata.eventId, "evt_01K2F8BAYX");
  assert.equal(r.metadata.traceId, "trc_01K2F8BAYX");
  // Escopo pode carregar dimensões vindas de telemetria; não vão para a DLQ.
  assert.equal(Object.keys(r.metadata).sort().join(","), "eventId,eventType,failures,schemaVersion,traceId");
});

test("acumula todas as violações de uma vez", () => {
  const r = parseAnalysisEvent({ eventType: "ANOMALY_DETECTION", schemaVersion: "3.0", payload: {} });
  const cod = codigos(r);
  assert.ok(cod.filter((c) => c === "MISSING_FIELD").length >= 6);
  assert.ok(cod.includes("UNSUPPORTED_SCHEMA_VERSION"));
});

test("a versão suportada é a do documento", () => {
  assert.equal(SUPPORTED_SCHEMA_VERSION, "1.0");
});

const sha256 = (entrada: string) => createHash("sha256").update(entrada).digest("hex");

/** Só os dois campos que compõem a identidade lógica (§5). */
function identidade(idempotencyKey: string) {
  return { eventType: "ANOMALY_DETECTION" as const, idempotencyKey };
}

test("analysisRunId é determinístico para a mesma execução lógica", () => {
  // Republicação técnica troca o eventId mas preserva a idempotencyKey; é a
  // segunda que define a execução, então o id precisa ser o mesmo.
  assert.equal(
    analysisRunId(identidade("ana_01K2F8BAYX"), sha256),
    analysisRunId(identidade("ana_01K2F8BAYX"), sha256),
  );
});

test("chave de idempotência diferente é outra execução", () => {
  assert.notEqual(
    analysisRunId(identidade("ana_01K2F8BAYX"), sha256),
    analysisRunId(identidade("ana_OUTRA"), sha256),
  );
});

test("mesmo idempotencyKey em tipos diferentes não colide", () => {
  const a = analysisRunId({ eventType: "ANOMALY_DETECTION", idempotencyKey: "k" }, sha256);
  const b = analysisRunId({ eventType: "QOE_FORECAST", idempotencyKey: "k" }, sha256);
  assert.notEqual(a, b);
});

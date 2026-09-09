import { test } from "node:test";
import assert from "node:assert/strict";

import { investigate, type InvestigationInput, type InvestigationDeps } from "../src/application/investigate.js";
import { createFakeProvider, type FakeProviderOptions } from "../src/adapters/llm/fake-provider.js";
import type { MlSignal } from "../src/domain/ml-result.js";

const SINAL: MlSignal = {
  detector: "univariate-robust-z",
  scale: "robust-z",
  score: 6,
  threshold: { value: 4, origin: "loio-calibration" },
  model: { name: "robust-z-walkforward", version: "2026.09.01" },
  observedAt: "2026-09-08T12:00:00Z",
  series: { source: "rpaas", entity: "search-api-rpaas-be-gcp-prod", metric: "error_rate" },
};

const EVIDENCIA = [
  { id: "ev_01", type: "metric", description: "Erro 5xx subiu 4x", source: "rpaas", strength: "forte", capturedAt: "2026-09-08T11:58:00Z" },
  { id: "ev_02", type: "log", description: "Timeout no origin", source: "newrelic", strength: "média", capturedAt: "2026-09-08T11:59:00Z" },
];

function entrada(overrides: Partial<InvestigationInput> = {}): InvestigationInput {
  return {
    incidentId: "inc-001",
    trigger: "reactive",
    signal: SINAL,
    incident: { component: "Playback", services: ["search-api"] },
    evidence: EVIDENCIA,
    quality: { history: { days: 7, points: 480 }, entities: { scoped: 2, observed: 9 }, signalAgeMinutes: 5 },
    goldenCase: null,
    ...overrides,
  };
}

/** Relógio e id fixos: o diagnóstico inteiro fica determinístico. */
function deps(options: FakeProviderOptions = {}, extra: Partial<InvestigationDeps> = {}): InvestigationDeps {
  return {
    llm: createFakeProvider(options),
    now: () => new Date("2026-09-08T12:00:05Z"),
    newDiagnosisId: () => "diag_01",
    ...extra,
  };
}

const HIPOTESE = {
  title: "Degradação na origem",
  explanation: "Timeout no origin acompanha a subida de 5xx.",
  confidence: 0.8,
  supportingEvidenceIds: ["ev_01", "ev_02"],
};

test("caminho feliz produz diagnóstico pronto com procedência do modelo", async () => {
  const resultado = await investigate(entrada(), deps({ hypotheses: [HIPOTESE] }));
  assert.equal(resultado.status, "ready");
  assert.equal(resultado.source, "llm");
  assert.equal(resultado.model?.promptVersion, "rca-v1");
  assert.equal(resultado.hypotheses.length, 1);
  assert.equal(resultado.diagnosisId, "diag_01");
});

test("gate reprovado difere ANTES de chamar o modelo", async () => {
  const provider = createFakeProvider({ hypotheses: [HIPOTESE] });
  const resultado = await investigate(
    entrada({ evidence: [] }),
    { ...deps(), llm: provider },
  );
  assert.equal(resultado.status, "deferred");
  // O ponto econômico da camada: sem evidência, nenhuma inferência é paga.
  assert.equal(provider.calls.length, 0);
  assert.ok(resultado.reasons.some((r) => r.code === "NO_EVIDENCE"));
});

test("margem fina difere sem gastar inferência", async () => {
  const provider = createFakeProvider({ hypotheses: [HIPOTESE] });
  const rasteiro = { ...SINAL, score: 4.1 };
  const resultado = await investigate(entrada({ signal: rasteiro }), { ...deps(), llm: provider });
  assert.equal(resultado.status, "deferred");
  assert.equal(provider.calls.length, 0);
});

test("caso curado tem precedência e não aciona o modelo", async () => {
  const provider = createFakeProvider({ hypotheses: [HIPOTESE] });
  const resultado = await investigate(
    entrada({
      goldenCase: {
        caseId: "case-7",
        signature: "Identidade#Mobile#Nacional",
        expectedHypothesis: "Falha de autenticação em rede móvel",
        expectedScore: 0.85,
        curatedBy: "demo@globoplay.com",
      },
    }),
    { ...deps(), llm: provider },
  );
  assert.equal(resultado.status, "ready");
  assert.equal(resultado.source, "golden-set");
  // Sem modelo por trás, `model` fica nulo em vez de inventar procedência.
  assert.equal(resultado.model, null);
  assert.equal(provider.calls.length, 0);
});

test("erro do provider vira failed, não inconclusive", async () => {
  const resultado = await investigate(entrada(), deps({ throws: new Error("throttled") }));
  assert.equal(resultado.status, "failed");
  assert.deepEqual(resultado.reasons.map((r) => r.code), ["PROVIDER_ERROR"]);
});

test("resposta truncada vira failed com a procedência preservada", async () => {
  const resultado = await investigate(
    entrada(),
    deps({ hypotheses: [HIPOTESE], stopReason: "length" }),
  );
  assert.equal(resultado.status, "failed");
  assert.deepEqual(resultado.reasons.map((r) => r.code), ["TRUNCATED"]);
  assert.equal(resultado.model?.provider, "fake");
});

test("nada acima do piso é inconclusive, e não falha", async () => {
  const resultado = await investigate(
    entrada(),
    deps({ hypotheses: [{ ...HIPOTESE, confidence: 0.2 }] }),
  );
  assert.equal(resultado.status, "inconclusive");
  // Distinção que decide o alarme: funcionou, e não tinha o que dizer.
  assert.equal(resultado.hypotheses.length, 1);
});

test("hipóteses saem ordenadas por confiança, não pela ordem do modelo", async () => {
  const resultado = await investigate(
    entrada(),
    deps({
      hypotheses: [
        { ...HIPOTESE, title: "fraca", confidence: 0.3 },
        { ...HIPOTESE, title: "forte", confidence: 0.9 },
      ],
    }),
  );
  assert.deepEqual(resultado.hypotheses.map((h) => [h.title, h.rank]), [["forte", 1], ["fraca", 2]]);
});

test("evidência inventada é descartada e o descarte fica registrado", async () => {
  const resultado = await investigate(
    entrada(),
    deps({
      hypotheses: [HIPOTESE, { ...HIPOTESE, title: "inventada", supportingEvidenceIds: ["ev_99"] }],
    }),
  );
  assert.equal(resultado.status, "ready");
  assert.equal(resultado.hypotheses.length, 1);
  assert.deepEqual(resultado.reasons.map((r) => r.code), ["UNKNOWN_EVIDENCE"]);
});

test("caminho preventivo funciona sem incidente", async () => {
  const previsao: MlSignal = {
    detector: "qoe-forecast",
    scale: "qoe-bufferratio",
    score: 0.12,
    threshold: { value: 0.08, origin: "train-percentile", percentile: 90 },
    model: { name: "rf-qoe-1h", version: "2026.09.01" },
    observedAt: "2026-09-08T12:00:00Z",
    signalId: "sinal-42",
    horizonHours: 1,
  };
  const resultado = await investigate(
    entrada({
      incidentId: null,
      trigger: "preventive",
      signal: previsao,
      quality: { history: { days: 7, points: 480 }, entities: { scoped: 0, observed: 0 }, signalAgeMinutes: 5 },
    }),
    deps({ hypotheses: [HIPOTESE] }),
  );
  assert.equal(resultado.status, "ready");
  assert.equal(resultado.incidentId, null);
  assert.equal(resultado.trigger, "preventive");
});

test("o prompt entrega a evidência dentro do bloco delimitado", async () => {
  const provider = createFakeProvider({ hypotheses: [HIPOTESE] });
  await investigate(entrada(), { ...deps(), llm: provider });
  const enviado = provider.calls[0]?.userPrompt ?? "";
  assert.match(enviado, /<<<DADOS_DE_EVIDENCIA>>>/);
  assert.match(enviado, /<<<FIM_DADOS_DE_EVIDENCIA>>>/);
  assert.ok(enviado.indexOf("ev_01") > enviado.indexOf("<<<DADOS_DE_EVIDENCIA>>>"));
  assert.ok(enviado.indexOf("ev_01") < enviado.indexOf("<<<FIM_DADOS_DE_EVIDENCIA>>>"));
});

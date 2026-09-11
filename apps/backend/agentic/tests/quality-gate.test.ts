import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, evaluateQuality, type GateInput } from "../src/domain/quality-gate.js";
import { relativeMargin, type MlSignal } from "../src/domain/ml-result.js";

/** Sinal univariado bem acima do limiar, no formato do notebook (seção 8). */
function sinalUnivariado(score = 6): MlSignal {
  return {
    detector: "univariate-robust-z",
    scale: "robust-z",
    score,
    threshold: { value: 4, origin: "loio-calibration" },
    model: { name: "robust-z-walkforward", version: "2026.09.01" },
    observedAt: "2026-09-08T12:00:00Z",
    series: { source: "rpaas", entity: "search-api-rpaas-be-gcp-prod", metric: "error_rate" },
  };
}

/** Entrada que passa em tudo. Cada teste degrada um aspecto por vez. */
function entradaBoa(overrides: Partial<GateInput> = {}): GateInput {
  return {
    signal: sinalUnivariado(),
    evidenceCount: 3,
    history: { days: 7, points: 480 },
    entities: { scoped: 2, observed: 9 },
    signalAgeMinutes: 5,
    ...overrides,
  };
}

test("aprova quando evidência, histórico, escopo e margem estão dentro da política", () => {
  assert.deepEqual(evaluateQuality(entradaBoa()), { ok: true });
});

test("difere sem evidência — é o caso que hoje produz hipótese sobre nada", () => {
  const veredito = evaluateQuality(entradaBoa({ evidenceCount: 0 }));
  assert.equal(veredito.ok, false);
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "NO_EVIDENCE"));
});

test("difere com histórico abaixo do aquecimento de 3 dias do notebook", () => {
  const veredito = evaluateQuality(entradaBoa({ history: { days: 2, points: 480 } }));
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "INSUFFICIENT_HISTORY"));
});

test("difere com pontos abaixo do mínimo, mesmo com dias suficientes", () => {
  const veredito = evaluateQuality(entradaBoa({ history: { days: 10, points: 40 } }));
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "INSUFFICIENT_HISTORY"));
});

test("difere quando nenhuma entidade observada pertence ao serviço do incidente", () => {
  // É a correção de comparações múltiplas da seção 8: sem escopo, o falso
  // positivo medido no notebook chegava a ~92%.
  const veredito = evaluateQuality(entradaBoa({ entities: { scoped: 0, observed: 40 } }));
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "UNSCOPED_ENTITIES"));
});

test("previsão de QoE não é reprovada por falta de escopo: ela não tem entidades", () => {
  const previsao: MlSignal = {
    detector: "qoe-forecast",
    scale: "qoe-risk",
    score: 0.81,
    threshold: { value: 0.7, origin: "train-percentile", percentile: 90 },
    model: { name: "qoe-forecast", version: "2026.09.1" },
    observedAt: "2026-09-08T12:00:00Z",
    predictedValue: 0.083,
    riskLevel: "ELEVATED",
    targetWindow: { start: "2026-09-08T13:00:00Z", end: "2026-09-08T14:00:00Z" },
  };
  const veredito = evaluateQuality(
    entradaBoa({ signal: previsao, entities: { scoped: 0, observed: 0 } }),
  );
  assert.deepEqual(veredito, { ok: true });
});

test("difere quando o score passa raspando — é a faixa do falso positivo", () => {
  // 4.2 contra limiar 4 = 5% de margem, abaixo dos 10% da política.
  const veredito = evaluateQuality(entradaBoa({ signal: sinalUnivariado(4.2) }));
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "MARGIN_TOO_THIN"));
});

test("não acusa margem fina quando o sinal sequer passou do limiar", () => {
  // Os dois motivos se sobreporiam e confundiriam quem lê o diferimento.
  const veredito = evaluateQuality(entradaBoa({ signal: sinalUnivariado(3) }));
  assert.ok(veredito.ok === false);
  if (veredito.ok === false) {
    const codigos = veredito.reasons.map((r) => r.code);
    assert.ok(codigos.includes("SIGNAL_BELOW_THRESHOLD"));
    assert.ok(!codigos.includes("MARGIN_TOO_THIN"));
  }
});

test("difere com sinal velho demais", () => {
  const veredito = evaluateQuality(entradaBoa({ signalAgeMinutes: 120 }));
  assert.ok(veredito.ok === false && veredito.reasons.some((r) => r.code === "STALE_SIGNAL"));
});

test("acumula todos os motivos, não só o primeiro", () => {
  const veredito = evaluateQuality(
    entradaBoa({
      evidenceCount: 0,
      history: { days: 1, points: 10 },
      entities: { scoped: 0, observed: 3 },
      signalAgeMinutes: 999,
    }),
  );
  assert.ok(veredito.ok === false && veredito.reasons.length === 4);
});

test("margem relativa é comparável entre escalas diferentes", () => {
  // Um z de 6 contra limiar 4 e uma distância de 30 contra limiar 20 estão
  // ambos 50% além da própria régua, apesar de escalas incomparáveis.
  const mahalanobis: MlSignal = {
    detector: "multivariate-mahalanobis",
    scale: "mahalanobis",
    score: 30,
    threshold: { value: 20, origin: "train-percentile", percentile: 99 },
    model: { name: "ledoit-wolf", version: "2026.09.01" },
    observedAt: "2026-09-08T12:00:00Z",
    dimensions: 68,
  };
  assert.equal(relativeMargin(sinalUnivariado(6)), 0.5);
  assert.equal(relativeMargin(mahalanobis), 0.5);
});

test("a política padrão preserva as constantes calibradas no notebook", () => {
  // Mudar estes dois exige refazer a calibração, então a mudança tem que
  // quebrar um teste e não passar despercebida numa revisão.
  assert.equal(DEFAULT_POLICY.minHistoryDays, 3);
  assert.equal(DEFAULT_POLICY.minHistoryPoints, 96);
});

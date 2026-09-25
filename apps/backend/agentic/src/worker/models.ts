import type { WindowedEvent } from "../contracts/analysis-event.js";
import type { MlSignal, QoeForecastSignal } from "../domain/ml-result.js";
import { mean } from "./facts.js";
import { AnalysisError, type AnalysisScope, type ModelResult, type Observation } from "./types.js";

export const FEATURES = ["bufferratio_avg", "lag_1h", "lag_2h", "lag_3h", "roll_mean_3h",
  "sessions", "errors", "startup_errors", "hora_sin", "hora_cos", "dia_semana"] as const;
export interface Tree { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[] }
export interface ModelBundle {
  schemaVersion: "analysis-models-v1"; name: string; version: string; approved: boolean;
  approval?: { reference: string; sourceSha256: string; approvedAt: string };
  trainedThrough: string; datasetVersion: string; features: string[];
  forecast: { trees: Tree[]; calibration: { x: number[]; y: number[] }; valueThreshold: number; riskThreshold: number; highRiskThreshold: number };
  detection: { robustThreshold: number; minHistoryDays: number; minHistoryPoints: number;
    scopes: Record<string, { metrics: string[]; mean: number[]; precision: number[][]; threshold: number }> };
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export function validateBundle(raw: unknown, allowUnapproved = false): ModelBundle {
  const b = raw as ModelBundle;
  if (!b || b.schemaVersion !== "analysis-models-v1" || !b.name || !b.version || !b.datasetVersion ||
    !Number.isFinite(Date.parse(b.trainedThrough)) || (!allowUnapproved && b.approved !== true) ||
    JSON.stringify(b.features) !== JSON.stringify(FEATURES) || !b.forecast || !b.detection) throw new AnalysisError("INVALID_MODEL_MANIFEST", true);
  if (b.approved && (!b.approval || !b.approval.reference || !/^[a-f0-9]{64}$/.test(b.approval.sourceSha256) || !Number.isFinite(Date.parse(b.approval.approvedAt))))
    throw new AnalysisError("INVALID_MODEL_APPROVAL", true);
  const f = b.forecast, d = b.detection;
  if (![f.valueThreshold, f.riskThreshold, f.highRiskThreshold, d.robustThreshold].every(finite) ||
    f.valueThreshold < 0 || f.riskThreshold <= 0 || f.highRiskThreshold <= f.riskThreshold || f.highRiskThreshold > 1 ||
    d.robustThreshold <= 0 || !Number.isInteger(d.minHistoryDays) || d.minHistoryDays < 3 ||
    !Number.isInteger(d.minHistoryPoints) || d.minHistoryPoints < 96 || !Array.isArray(f.trees) || !f.trees.length || f.trees.length > 1000)
    throw new AnalysisError("INVALID_MODEL_PARAMETERS", true);
  const c = f.calibration;
  if (!c || !Array.isArray(c.x) || !Array.isArray(c.y) || c.x.length < 2 || c.x.length !== c.y.length ||
    !c.x.every(finite) || !c.y.every(v => finite(v) && v >= 0 && v <= 1) ||
    c.x.some((x, i) => i > 0 && x <= c.x[i - 1]!) || c.y.some((y, i) => i > 0 && y < c.y[i - 1]!)) throw new AnalysisError("INVALID_RISK_CALIBRATION", true);
  for (const tree of f.trees) {
    const n = tree.value?.length;
    if (!n || n > 100000 || ![tree.left, tree.right, tree.feature, tree.threshold, tree.value].every(a => Array.isArray(a) && a.length === n && a.every(finite)))
      throw new AnalysisError("INVALID_FOREST", true);
    const seen = new Set<number>();
    const visit = (i: number, depth: number): void => {
      if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i) || depth > 64) throw new AnalysisError("INVALID_TREE", true);
      seen.add(i);
      if (tree.left[i] === -1 && tree.right[i] === -1) return;
      if (!Number.isInteger(tree.feature[i]) || tree.feature[i]! < 0 || tree.feature[i]! >= FEATURES.length) throw new AnalysisError("INVALID_TREE_FEATURE", true);
      visit(tree.left[i]!, depth + 1); visit(tree.right[i]!, depth + 1);
    };
    visit(0, 0);
  }
  if (!d.scopes || typeof d.scopes !== "object") throw new AnalysisError("INVALID_DETECTOR", true);
  for (const m of Object.values(d.scopes)) {
    const n = m.metrics?.length;
    if (!n || n > 32 || new Set(m.metrics).size !== n || !m.metrics.every(x => typeof x === "string") ||
      !Array.isArray(m.mean) || m.mean.length !== n || !m.mean.every(finite) ||
      !Array.isArray(m.precision) || m.precision.length !== n || !m.precision.every(row => Array.isArray(row) && row.length === n && row.every(finite)) ||
      !finite(m.threshold) || m.threshold <= 0) throw new AnalysisError("INVALID_DETECTOR", true);
    const diagonal = Array.from({ length: n }, (_, i) => m.precision[i]![i]!);
    if (diagonal.some(value => !finite(value) || value <= 0)) throw new AnalysisError("INVALID_DETECTOR_PRECISION", true);
    // Verifica a matriz após normalizar a diagonal. A propriedade positiva
    // definida não depende da unidade; uma tolerância absoluta rejeitaria
    // precisões válidas de métricas grandes, como contagens de sessões.
    const normalized = m.precision.map((row, i) => row.map((value, j) => value / Math.sqrt(diagonal[i]! * diagonal[j]!)));
    const lower = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      const scale = Math.max(1, Math.abs(m.precision[i]![j]!), Math.abs(m.precision[j]![i]!));
      if (Math.abs(m.precision[i]![j]! - m.precision[j]![i]!) > 1e-10 * scale) throw new AnalysisError("INVALID_DETECTOR_PRECISION", true);
      const sum = normalized[i]![j]! - Array.from({ length: j }, (_, k) => lower[i]![k]! * lower[j]![k]!).reduce((a, b) => a + b, 0);
      if (i === j) { if (sum <= 1e-12) throw new AnalysisError("INVALID_DETECTOR_PRECISION", true); lower[i]![j] = Math.sqrt(sum); }
      else lower[i]![j] = sum / lower[j]![j]!;
    }
  }
  return b;
}

export function forecastFeatures(rows: Observation[], event: WindowedEvent): number[] | null {
  const hour = Date.parse(event.payload.window.start);
  const value = (metric: string, offset = 0): number | null => rows.find(r => r.metric === metric && r.grainSeconds === 3600 && Date.parse(r.timestamp) === hour - offset * 3600000)?.value ?? null;
  const current = value("bufferratio_avg"), lags = [1, 2, 3].map(lag => value("bufferratio_avg", lag));
  const date = new Date(hour), h = date.getUTCHours();
  const values = [current, ...lags, lags.every(finite) ? mean(lags as number[]) : null,
    value("sessions"), value("errors"), value("startup_errors"), Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24), (date.getUTCDay() + 6) % 7];
  return values.every(finite) ? values as number[] : null;
}
export function predictForest(trees: Tree[], features: number[]): number {
  return mean(trees.map(tree => {
    let i = 0;
    while (tree.left[i] !== -1) i = features[tree.feature[i]!]! <= tree.threshold[i]! ? tree.left[i]! : tree.right[i]!;
    return tree.value[i]!;
  }))!;
}
export function calibrate(value: number, table: { x: number[]; y: number[] }): number {
  if (value <= table.x[0]!) return table.y[0]!;
  for (let i = 1; i < table.x.length; i++) if (value <= table.x[i]!) {
    const fraction = (value - table.x[i - 1]!) / (table.x[i]! - table.x[i - 1]!);
    return table.y[i - 1]! + fraction * (table.y[i]! - table.y[i - 1]!);
  }
  return table.y.at(-1)!;
}
const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b), n = s.length; return n % 2 ? s[Math.floor(n / 2)]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };

export function infer(bundle: ModelBundle, event: WindowedEvent, scope: AnalysisScope, rows: Observation[]): ModelResult {
  const window = event.payload.window, start = Date.parse(window.start), end = Date.parse(window.end);
  if (Date.parse(bundle.trainedThrough) > start) throw new AnalysisError("MODEL_TEMPORAL_LEAKAGE", true);
  const result: ModelResult = { signals: [], reasons: [], historyDays: 0, historyPoints: 0, coverage: 0, modelVersion: bundle.version };
  if (event.eventType === "QOE_FORECAST") {
    if (event.payload.model?.name !== bundle.name || event.payload.model.version !== bundle.version) throw new AnalysisError("MODEL_VERSION_MISMATCH", true);
    const features = forecastFeatures(rows, event);
    if (!features || features[5]! <= 0) return { ...result, reasons: ["FORECAST_FEATURES_INCOMPLETE"] };
    const predictedValue = predictForest(bundle.forecast.trees, features), risk = calibrate(predictedValue, bundle.forecast.calibration);
    const signal: QoeForecastSignal = { detector: "qoe-forecast", scale: "qoe-risk", model: { name: bundle.name, version: bundle.version },
      score: risk, predictedValue, threshold: { value: bundle.forecast.riskThreshold, origin: "manual" }, observedAt: window.end,
      riskLevel: risk > bundle.forecast.highRiskThreshold ? "HIGH" : risk > bundle.forecast.riskThreshold ? "ELEVATED" : "NORMAL",
      targetWindow: event.payload.targetWindow!, experimental: true };
    return { ...result, signals: [signal], coverage: 1, historyPoints: 4, historyDays: 4 / 24 };
  }
  const day = Math.floor(start / 86400000) * 86400000;
  const observed = (metric: string) => rows.filter(r => r.metric === metric && r.grainSeconds === window.grainSeconds && Date.parse(r.timestamp) >= start && Date.parse(r.timestamp) + r.grainSeconds * 1000 <= end && r.value !== null);
  let minPoints = Infinity, minDays = Infinity, minCoverage = 1;
  for (const metric of scope.detectorMetrics) {
    const before = rows.filter(r => r.metric === metric && r.grainSeconds === window.grainSeconds && Date.parse(r.timestamp) >= day - 7 * 86400000 && Date.parse(r.timestamp) < day && r.value !== null);
    const days = new Set(before.map(r => r.timestamp.slice(0, 10))).size, current = observed(metric);
    minPoints = Math.min(minPoints, before.length); minDays = Math.min(minDays, days);
    minCoverage = Math.min(minCoverage, current.length / ((end - start) / (window.grainSeconds * 1000)));
    if (days < bundle.detection.minHistoryDays || before.length < bundle.detection.minHistoryPoints || !current.length) { result.reasons.push(`${metric}:INSUFFICIENT_HISTORY_OR_WINDOW`); continue; }
    const center = median(before.map(r => r.value!)), mad = median(before.map(r => Math.abs(r.value! - center))) * 1.4826;
    if (mad < 1e-9) { result.reasons.push(`${metric}:DEGENERATE_MAD`); continue; }
    const score = Math.max(...current.map(r => Math.abs(r.value! - center) / mad));
    result.signals.push({ detector: "univariate-robust-z", scale: "robust-z", model: { name: "robust-mad", version: bundle.version },
      score, threshold: { value: bundle.detection.robustThreshold, origin: "manual" }, observedAt: window.end,
      series: { source: scope.source, entity: scope.entity, metric } });
  }
  const multi = bundle.detection.scopes[scope.id];
  if (multi) {
    const vectors = new Map<string, Map<string, number>>();
    for (const metric of multi.metrics) for (const row of observed(metric)) {
      const at = vectors.get(row.timestamp) ?? new Map<string, number>(); at.set(metric, row.value!); vectors.set(row.timestamp, at);
    }
    const complete = [...vectors.values()].filter(v => multi.metrics.every(m => v.has(m)));
    if (!complete.length) result.reasons.push("MAHALANOBIS_INCOMPLETE_WINDOW");
    else {
      const scores = complete.map(v => {
        const delta = multi.metrics.map((m, i) => v.get(m)! - multi.mean[i]!);
        const square = delta.reduce((sum, di, i) => sum + di * delta.reduce((s, dj, j) => s + multi.precision[i]![j]! * dj, 0), 0);
        if (!Number.isFinite(square) || square < -1e-7) throw new AnalysisError("INVALID_MAHALANOBIS_RESULT", true);
        return Math.sqrt(Math.max(0, square));
      });
      result.signals.push({ detector: "multivariate-mahalanobis", scale: "mahalanobis", dimensions: multi.metrics.length,
        model: { name: "ledoit-wolf-mahalanobis", version: bundle.version }, score: Math.max(...scores),
        threshold: { value: multi.threshold, origin: "train-percentile", percentile: 99 }, observedAt: window.end });
    }
  } else result.reasons.push("MAHALANOBIS_SCOPE_NOT_TRAINED");
  return { ...result, historyDays: Number.isFinite(minDays) ? minDays : 0, historyPoints: Number.isFinite(minPoints) ? minPoints : 0, coverage: minCoverage };
}

import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { WindowedEvent } from "../src/contracts/analysis-event.js";
import { cleanObservations, prepareContext } from "../src/worker/facts.js";
import { loadWorkerFiles } from "../src/worker/config.js";
import { infer } from "../src/worker/models.js";
import { isMaterial } from "../src/worker/orchestrator.js";
import type { AnalysisScope, Observation } from "../src/worker/types.js";

const DELIVERY: Record<string, string> = { cdn_live_errors: "cdn_live_err_rate", origin_live_errors: "origin_live_err_rate", origin_cdn_live_errors: "origin_cdn_live_err_rate" };
const DETECTOR_UNITS: Record<string, string> = { active_sessions: "count", active_with_error: "count", joins_in_bucket: "count", latency_ms_p50: "ms", latency_ms_p95: "ms", bufferratio_avg: "ratio-unconfirmed", jointime_s_avg: "seconds", dropped_frames_avg: "count/session" };
const HOURLY_UNITS: Record<string, string> = { bufferratio_avg: "ratio-unconfirmed", sessions: "count", errors: "count", startup_errors: "count" };

async function csv(path: string, consume: (row: string[]) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) { if (first) { first = false; continue; } consume(line.split(",")); }
}
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const value = (raw: string): number | null => { const parsed = Number(raw); return raw === "" || raw === "NULL" || !Number.isFinite(parsed) ? null : parsed; };
function observation(datasetVersion: string, scope: string, metric: string, unit: string, at: number, grainSeconds: number, raw: string, source: string): Observation {
  return { id: `${source}:${scope}:${metric}:${at}`, datasetVersion, scopeId: scope, metric, unit, timestamp: iso(at), grainSeconds, value: value(raw) };
}
function event(type: "ANOMALY_DETECTION" | "QOE_FORECAST", scope: AnalysisScope, start: number, model: { name: string; version: string; datasetVersion: string }): WindowedEvent {
  const grain = type === "ANOMALY_DETECTION" ? 900 : 3600, end = start + grain * 1000;
  return { eventId: `replay-${type}-${scope.id}-${start}`, eventType: type, schemaVersion: "1.0", idempotencyKey: `replay-${scope.id}-${start}`, traceId: "dry-replay", occurredAt: iso(end), producedAt: iso(end), source: "dry-replay",
    payload: { window: { start: iso(start), end: iso(end), grainSeconds: grain }, inputWatermark: iso(end), datasetVersion: model.datasetVersion, scope: { kind: "channel", dimensions: { scopeId: scope.id } },
      ...(type === "QOE_FORECAST" ? { model, targetWindow: { start: iso(end), end: iso(end + 3600000) } } : {}) } };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { data: { type: "string" }, model: { type: "string" }, catalog: { type: "string" }, start: { type: "string" }, end: { type: "string" }, output: { type: "string" } } });
  if (!args.data || !args.model || !args.catalog || !args.start || !args.end || !args.output) throw new Error("required: --data --model --catalog --start --end --output");
  const { model, scopes } = await loadWorkerFiles(args.model, args.catalog, true), wanted = new Set(scopes.map(scope => scope.id));
  const rows = new Map(scopes.map(scope => [scope.id, [] as Observation[]]));
  await csv(`${args.data}/detector.csv.gz`, ([timestamp, scope, metric, raw]) => { if (wanted.has(scope!) && metric! in DETECTOR_UNITS) rows.get(scope!)!.push(observation(model.datasetVersion, scope!, metric!, DETECTOR_UNITS[metric!]!, Number(timestamp), 900, raw!, "active")); });
  await csv(`${args.data}/qoe.csv.gz`, row => { const at = Number(row[0]), scope = row[1]!; if (!wanted.has(scope)) return; const names = ["sessions", "errors", "startup_errors", "bufferratio_avg"], positions = [2, 3, 4, 8]; for (let i = 0; i < names.length; i++) rows.get(scope)!.push(observation(model.datasetVersion, scope, names[i]!, HOURLY_UNITS[names[i]!]!, at, 3600, row[positions[i]!]!, "qoe")); });
  const deliveryBuckets = new Map<string, { timestamp: number; source: string; scope: string; alias: string; sum: number; count: number }>();
  await csv(`${args.data}/signal-bucket.csv.gz`, ([timestamp, source, scope, metric, raw]) => {
    const alias = DELIVERY[source!], parsed = value(raw!); if (!wanted.has(scope!) || !alias || metric !== "err_rate" || parsed === null) return;
    const key = `${timestamp}:${source}:${scope}`, bucket = deliveryBuckets.get(key) ?? { timestamp: Number(timestamp), source: source!, scope: scope!, alias, sum: 0, count: 0 };
    bucket.sum += parsed; bucket.count++; deliveryBuckets.set(key, bucket);
  });
  for (const bucket of deliveryBuckets.values()) rows.get(bucket.scope)!.push(observation(model.datasetVersion, bucket.scope, bucket.alias, "percent", bucket.timestamp, 900, String(bucket.sum / bucket.count), bucket.source));
  const start = Date.parse(args.start), end = Date.parse(args.end); if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("invalid replay interval");
  const report = { schemaVersion: "pilot-replay-v1", generatedAt: new Date().toISOString(), interval: { start: iso(start), end: iso(end) }, dryRun: true,
    model: { name: model.name, version: model.version, approved: model.approved }, scopes: [] as unknown[] };
  for (const scope of scopes) {
    const from = Math.floor(start / 86400000) * 86400000 - 7 * 86400000;
    const clean = cleanObservations(rows.get(scope.id)!, model.datasetVersion, scope, from, end + 3600000);
    type Episode = { start: string; end: string; buckets: number; peakRelativeMargin: number; triggerMetrics: string[]; deliveryAvailable: string[]; deliveryIncreases: string[] };
    let detectionWindows = 0, materialWindows = 0, alerts = 0, alertsWithDeliveryEvidence = 0, alertsWithDeliveryIncrease = 0, lastAlert: number | null = null;
    const episodeDetails: Episode[] = [];
    const alertsAtMinimumSessions: Record<string, number> = { "25": 0, "100": 0, "500": 0, "1000": 0 };
    for (let at = start; at < end; at += 900000) {
      const current = event("ANOMALY_DETECTION", scope, at, model), result = infer(model, current, scope, clean); detectionWindows++;
      if (!isMaterial(clean, current, scope)) continue; materialWindows++;
      const signal = result.signals.filter(item => item.score > item.threshold.value).sort((a, b) => b.score / b.threshold.value - a.score / a.threshold.value)[0];
      if (!signal || result.coverage !== 1) continue; alerts++;
      const activeSessions = clean.filter(row => row.metric === "active_sessions" && row.grainSeconds === 900 && Date.parse(row.timestamp) === at).reduce((sum, row) => sum + (row.value ?? 0), 0);
      for (const minimum of [25, 100, 500, 1000]) if (activeSessions >= minimum) alertsAtMinimumSessions[String(minimum)]!++;
      const context = prepareContext(clean, model.datasetVersion, scope, signal, current.payload.window.end, 3600, 50000, 900);
      const deliveryFacts = context.facts.filter(fact => Object.values(DELIVERY).includes(fact.metric) && fact.current !== null);
      const deliveryAvailable = deliveryFacts.map(fact => fact.metric), deliveryIncreases = deliveryFacts.filter(fact => fact.direction === "increase").map(fact => fact.metric);
      if (deliveryAvailable.length) alertsWithDeliveryEvidence++;
      if (deliveryIncreases.length) alertsWithDeliveryIncrease++;
      const triggerMetric = signal.detector === "univariate-robust-z" ? signal.series.metric : signal.detector;
      const margin = (signal.score - signal.threshold.value) / signal.threshold.value;
      if (lastAlert === null || at - lastAlert >= (scope.episodeWindowSeconds ?? 3600) * 1000) episodeDetails.push({ start: current.payload.window.start, end: current.payload.window.end, buckets: 1, peakRelativeMargin: margin, triggerMetrics: [triggerMetric], deliveryAvailable, deliveryIncreases });
      else {
        const episode = episodeDetails.at(-1)!; episode.end = current.payload.window.end; episode.buckets++;
        episode.peakRelativeMargin = Math.max(episode.peakRelativeMargin, margin);
        episode.triggerMetrics = [...new Set([...episode.triggerMetrics, triggerMetric])];
        episode.deliveryAvailable = [...new Set([...episode.deliveryAvailable, ...deliveryAvailable])];
        episode.deliveryIncreases = [...new Set([...episode.deliveryIncreases, ...deliveryIncreases])];
      }
      lastAlert = at;
    }
    const confusion = { TP: 0, FP: 0, FN: 0, TN: 0 }, persistence = { TP: 0, FP: 0, FN: 0, TN: 0 }, forecast = { windows: 0, alerts: 0, evaluated: 0, confusion, persistence };
    for (let at = Math.ceil(start / 3600000) * 3600000; at + 3600000 < end; at += 3600000) {
      const current = event("QOE_FORECAST", scope, at, model), result = infer(model, current, scope, clean), signal = result.signals.find(item => item.detector === "qoe-forecast"); forecast.windows++;
      if (!signal) continue; const actual = clean.find(row => row.metric === "bufferratio_avg" && row.grainSeconds === 3600 && Date.parse(row.timestamp) === at + 3600000)?.value;
      if (actual === null || actual === undefined) continue; forecast.evaluated++;
      const predicted = signal.score > signal.threshold.value, observed = actual > model.forecast.valueThreshold; if (predicted) forecast.alerts++;
      confusion[predicted ? observed ? "TP" : "FP" : observed ? "FN" : "TN"]++;
      const currentValue = clean.find(row => row.metric === "bufferratio_avg" && row.grainSeconds === 3600 && Date.parse(row.timestamp) === at)?.value;
      if (currentValue !== null && currentValue !== undefined) {
        const baseline = currentValue > model.forecast.valueThreshold;
        persistence[baseline ? observed ? "TP" : "FP" : observed ? "FN" : "TN"]++;
      }
    }
    report.scopes.push({ scopeId: scope.id, observations: clean.length, detection: { windows: detectionWindows, materialWindows, alerts, alertsAtMinimumSessions, episodes: episodeDetails.length, alertsWithDeliveryEvidence, alertsWithDeliveryIncrease, episodeDetails }, forecast });
  }
  await writeFile(args.output, JSON.stringify(report, null, 2) + "\n");
}

await main();

import { createHash } from "node:crypto";
import type { MlSignal } from "../domain/ml-result.js";
import { AnalysisError, type AnalysisScope, type Fact, type Observation, type PreparedContext } from "./types.js";

export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Bucket timestamps are starts; only fully published buckets enter inference. */
export function cleanObservations(rows: Observation[], dataset: string, scope: AnalysisScope, from: number, cutoff: number): Observation[] {
  const unique = new Map<string, Observation>();
  const slots = new Map<string, string>();
  for (const row of rows) {
    const definition = scope.series.find(s => s.metric === row.metric && s.grainSeconds === row.grainSeconds);
    const timestamp = Date.parse(row.timestamp);
    if (!definition || row.datasetVersion !== dataset || row.scopeId !== scope.id || !Number.isFinite(timestamp) ||
        timestamp % (row.grainSeconds * 1000) !== 0 ||
        row.grainSeconds !== definition.grainSeconds || row.unit !== definition.unit ||
        !row.id || (row.value !== null && !Number.isFinite(row.value))) throw new AnalysisError("INVALID_OBSERVATION", true);
    if (timestamp < from || timestamp + row.grainSeconds * 1000 > cutoff) continue;
    const slot = `${row.metric}:${timestamp}`;
    if (slots.has(slot) && slots.get(slot) !== row.id) throw new AnalysisError("DUPLICATE_BUCKET", true);
    const prior = unique.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new AnalysisError("CONFLICTING_OBSERVATION", true);
    unique.set(row.id, row); slots.set(slot, row.id);
  }
  return [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.metric.localeCompare(b.metric));
}

function makeFact(input: Omit<Fact, "id" | "statement" | "direction">, tolerance: number): Fact {
  const direction = input.reference === null || input.current === null ? "unavailable" :
    Math.abs(input.current - input.reference) <= tolerance ? "stable" : input.current > input.reference ? "increase" : "decrease";
  const show = (v: number | null) => v === null ? "ausente" : v.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
  return { ...input, id: `fact:${hash(input).slice(0, 24)}`, direction,
    statement: `${input.metric} (${input.method}, ${input.unit}): ${show(input.reference)} → ${show(input.current)}; ${direction}. Cobertura: ${input.referenceCount}/${input.expectedPoints} e ${input.currentCount}/${input.expectedPoints}.` };
}

export function prepareContext(rows: Observation[], dataset: string, scope: AnalysisScope, signal: MlSignal,
  cutoff: string, windowSeconds = 3600, maxBytes = 50000, preferredGrainSeconds?: number): PreparedContext {
  const end = Date.parse(cutoff), split = end - windowSeconds * 1000, start = split - windowSeconds * 1000;
  const facts: Fact[] = [], gaps: string[] = [];
  const definitions = preferredGrainSeconds === undefined ? scope.series : scope.series.filter(def => def.grainSeconds === preferredGrainSeconds);
  for (const def of definitions) {
    // Do not turn hourly QoE into quarter-hour measurements.
    if (windowSeconds < def.grainSeconds || windowSeconds % def.grainSeconds !== 0) { gaps.push(`${def.metric}: incompatible grain`); continue; }
    const selected = rows.filter(r => r.metric === def.metric && r.grainSeconds === def.grainSeconds && Date.parse(r.timestamp) >= start && Date.parse(r.timestamp) + r.grainSeconds * 1000 <= end);
    const before = selected.filter(r => Date.parse(r.timestamp) < split && finite(r.value));
    const after = selected.filter(r => Date.parse(r.timestamp) >= split && finite(r.value));
    const expected = windowSeconds / def.grainSeconds;
    const fact = makeFact({ scopeId: scope.id, metric: def.metric, unit: def.unit, method: "mean",
      start: new Date(start).toISOString(), split: new Date(split).toISOString(), end: cutoff,
      reference: mean(before.map(r => r.value!)), current: mean(after.map(r => r.value!)),
      referenceCount: before.length, currentCount: after.length, expectedPoints: expected, sourceIds: selected.map(r => r.id) }, 1e-9);
    facts.push(fact);
    if (before.length < expected || after.length < expected) gaps.push(`${def.metric}: incomplete coverage`);
  }
  for (const metric of ["errors", "startup_errors"]) {
    const def = definitions.find(s => s.metric === metric), sessions = definitions.find(s => s.metric === "sessions");
    if (!def || !sessions || def.grainSeconds !== sessions.grainSeconds || windowSeconds % def.grainSeconds !== 0) continue;
    const rates = [start, split].map(lo => {
      const events = rows.filter(r => r.metric === metric && r.grainSeconds === def.grainSeconds && Date.parse(r.timestamp) >= lo && Date.parse(r.timestamp) + r.grainSeconds * 1000 <= lo + windowSeconds * 1000);
      const pairs = events.flatMap(r => {
        const denominator = rows.find(s => s.metric === "sessions" && s.grainSeconds === sessions.grainSeconds && s.timestamp === r.timestamp);
        return finite(r.value) && r.value >= 0 && denominator && finite(denominator.value) && denominator.value > 0 ? [[r, denominator] as const] : [];
      });
      return { value: pairs.length ? pairs.reduce((sum, p) => sum + p[0].value!, 0) / pairs.reduce((sum, p) => sum + p[1].value!, 0) : null,
        count: pairs.length, ids: pairs.flatMap(p => p.map(r => r.id)) };
    });
    facts.push(makeFact({ scopeId: scope.id, metric: `${metric}_per_session_pooled`, unit: "events/session; not probability", method: "ratio-of-sums",
      start: new Date(start).toISOString(), split: new Date(split).toISOString(), end: cutoff,
      reference: rates[0]!.value, current: rates[1]!.value, referenceCount: rates[0]!.count, currentCount: rates[1]!.count,
      expectedPoints: windowSeconds / def.grainSeconds, sourceIds: rates.flatMap(r => r.ids) }, 1e-9));
  }
  const base = { version: "a-prime-context-v1" as const, datasetVersion: dataset, scopeId: scope.id, cutoff, signal, facts, gaps };
  if (Buffer.byteLength(JSON.stringify(base)) > maxBytes) throw new AnalysisError("CONTEXT_BUDGET_EXCEEDED", true);
  return { ...base, hash: hash(base) };
}

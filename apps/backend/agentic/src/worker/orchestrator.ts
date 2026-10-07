import { randomUUID } from "node:crypto";
import { analysisRunId, parseAnalysisEvent, type WindowedEvent } from "../contracts/analysis-event.js";
import type { LlmProvider } from "../ports/llm-provider.js";
import { cleanObservations, hash as digest, prepareContext, prepareDiagnosisProjection } from "./facts.js";
import { infer, type ModelBundle } from "./models.js";
import { interpret } from "./interpret.js";
import { AnalysisError, type AnalysisQueue, type AnalysisScope, type AnalysisStore, type Delivery, type Lease, type ObservationReader, type ScopeCheckpoint, type Telemetry } from "./types.js";

export function validateWindow(event: WindowedEvent): void {
  const w = event.payload.window, start = Date.parse(w.start), end = Date.parse(w.end);
  const grain = event.eventType === "QOE_FORECAST" ? 3600 : 900;
  if (!event.source || w.grainSeconds !== grain || end - start !== grain * 1000 || start % (grain * 1000) ||
    !Number.isFinite(Date.parse(event.payload.inputWatermark)) || Date.parse(event.payload.inputWatermark) < end)
    throw new AnalysisError("INVALID_COMPLETE_WINDOW", true);
  if (event.eventType === "QOE_FORECAST" && (!event.payload.model || !event.payload.targetWindow ||
    Date.parse(event.payload.targetWindow.start) !== end || Date.parse(event.payload.targetWindow.end) !== end + 3600000))
    throw new AnalysisError("INVALID_FORECAST_TARGET", true);
}

export function isMaterial(rows: import("./types.js").Observation[], event: WindowedEvent, scope: AnalysisScope): boolean {
  if (!scope.materiality?.length) return true;
  const start = Date.parse(event.payload.window.start), end = Date.parse(event.payload.window.end);
  return scope.materiality.every(rule => rows
    .filter(row => row.metric === rule.metric && row.grainSeconds === event.payload.window.grainSeconds &&
      Date.parse(row.timestamp) >= start && Date.parse(row.timestamp) + row.grainSeconds * 1000 <= end && row.value !== null)
    .reduce((sum, row) => sum + row.value!, 0) >= rule.minimum);
}

export class AnalysisWorker {
  constructor(private readonly deps: { queue: AnalysisQueue; store: AnalysisStore; reader: ObservationReader;
    model: ModelBundle; scopes: AnalysisScope[]; llm: LlmProvider; telemetry?: Telemetry; now?: () => number }) {}

  async process(delivery: Delivery): Promise<void> {
    const { queue, store } = this.deps, now = this.deps.now ?? Date.now;
    const log = this.deps.telemetry ?? (() => {});
    let lease: Lease | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let eventType = "unknown";
    let heartbeat: Promise<void> = Promise.resolve(), lost = false;
    const stopHeartbeat = async () => { if (timer) clearInterval(timer); await heartbeat; };
    try {
      let raw: unknown;
      try { raw = JSON.parse(delivery.body); } catch { throw new AnalysisError("INVALID_JSON", true); }
      const parsed = parseAnalysisEvent(raw);
      if (!parsed.ok) throw new AnalysisError("INVALID_EVENT_CONTRACT", true);
      const event = parsed.event;
      eventType = event.eventType;
      log("analysis_started", {
        eventType,
        deliveryId: delivery.id,
        receives: delivery.receives,
      });
      const runId = analysisRunId(event, digest), owner = randomUUID();
      const claim = await store.acquire(runId, owner, now(), 300000, digest({ type: event.eventType, payload: event.payload }));
      if (claim === "complete") {
        log("analysis_completed", { eventType, reason: "duplicate", scopes: 0 });
        await queue.acknowledge(delivery.receipt);
        return;
      }
      if (claim === "busy") {
        log("analysis_deferred", { eventType, reason: "lease_busy" });
        await queue.visibility(delivery.receipt, 60);
        return;
      }
      lease = { runId, owner };
      const activeLease = lease;
      timer = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          if (lost) return;
          try { await store.renew(activeLease, now(), 300000); await queue.visibility(delivery.receipt, 300); }
          catch { lost = true; }
        });
      }, 60000);
      const resolved = event.eventType === "REANALYSIS_REQUESTED" ? await store.resolveIncident(event.payload.incidentId) : null;
      const windowed = event.eventType === "REANALYSIS_REQUESTED" ? resolved!.event : event;
      validateWindow(windowed);
      if (windowed.payload.datasetVersion !== this.deps.model.datasetVersion) throw new AnalysisError("MODEL_DATASET_MISMATCH", true);
      const selection = windowed.payload.scope;
      const selectedId = selection?.dimensions.scopeId;
      if (selection && selection.kind !== "global" && typeof selectedId !== "string") throw new AnalysisError("INVALID_SCOPE", true);
      const scopes = resolved ? [resolved.scope] : this.deps.scopes.filter(s => !selection || selection.kind === "global" || s.id === selectedId);
      if (!scopes.length) throw new AnalysisError("UNKNOWN_SCOPE", true);
      for (const scope of scopes) {
        if (lost) throw new AnalysisError("LEASE_LOST");
        let checkpoint = await store.checkpoint(lease, scope.id);
        if (!checkpoint) {
          const day = Math.floor(Date.parse(windowed.payload.window.start) / 86400000) * 86400000;
          const from = new Date(day - 7 * 86400000).toISOString();
          const rows = cleanObservations(await this.deps.reader.read(windowed, scope, from), windowed.payload.datasetVersion, scope, Date.parse(from), Date.parse(windowed.payload.window.end));
          const result = infer(this.deps.model, windowed, scope, rows);
          const material = windowed.eventType !== "ANOMALY_DETECTION" || isMaterial(rows, windowed, scope);
          if (!material) result.reasons.push("MATERIALITY_GATE_NOT_MET");
          await store.validatePredictions(lease, windowed, scope, rows, 3600000);
          const eligible = result.coverage === 1 && (windowed.eventType === "QOE_FORECAST" ||
            (result.historyDays >= this.deps.model.detection.minHistoryDays && result.historyPoints >= this.deps.model.detection.minHistoryPoints));
          const elevated = eligible && material ? result.signals.filter(s => s.score > s.threshold.value).sort((a, b) => b.score / b.threshold.value - a.score / a.threshold.value)[0] : undefined;
          checkpoint = { event: windowed, scope, result,
            context: elevated ? prepareContext(rows, windowed.payload.datasetVersion, scope, elevated, windowed.payload.window.end, 3600, 50000, windowed.payload.window.grainSeconds) : null,
            presentation: prepareDiagnosisProjection(rows, windowed, scope),
            incidentId: resolved?.incidentId ?? null,
            predictionId: windowed.eventType === "QOE_FORECAST" && result.signals.length ? `pred_${digest({ runId, scope: scope.id }).slice(0, 32)}` : null };
          await store.saveCheckpoint(lease, scope.id, checkpoint);
        }
        if (checkpoint.context && !checkpoint.incidentId && windowed.eventType === "ANOMALY_DETECTION") {
          const correlation = await store.correlate(lease, windowed, scope, (scope.episodeWindowSeconds ?? 3600) * 1000);
          checkpoint.incidentId = correlation.incidentId;
          checkpoint.episodeStarted = correlation.isNew;
          await store.saveCheckpoint(lease, scope.id, checkpoint);
        }
        await store.saveResult(lease, checkpoint);
        const shouldDiagnose = checkpoint.context && (windowed.eventType !== "ANOMALY_DETECTION" || checkpoint.episodeStarted !== false);
        if (shouldDiagnose && !checkpoint.diagnosis && !checkpoint.diagnosticFailure) {
          try { checkpoint.diagnosis = await interpret(checkpoint.context!, this.deps.llm); }
          catch (error) {
            if (!(error instanceof AnalysisError) || !error.permanent) throw error;
            checkpoint.diagnosticFailure = error.code;
          }
          await store.saveCheckpoint(lease, scope.id, checkpoint);
        }
        if (shouldDiagnose) await store.saveDiagnosis(lease, checkpoint);
      }
      await stopHeartbeat();
      if (lost) throw new AnalysisError("LEASE_LOST");
      await store.finish(lease, "SUCCEEDED", now());
      await queue.acknowledge(delivery.receipt);
      log("analysis_completed", { eventType, runId: lease.runId, scopes: scopes.length });
    } catch (error) {
      await stopHeartbeat();
      const code = error instanceof AnalysisError ? error.code : "DEPENDENCY_FAILURE";
      const terminal = (error instanceof AnalysisError && error.permanent) || delivery.receives >= 5;
      log("analysis_failed", {
        eventType,
        runId: lease?.runId ?? null,
        code,
        status: terminal ? "failure" : "retry",
        terminal,
      });
      if (lost || code === "LEASE_LOST") return;
      if (terminal) {
        await queue.deadLetter(delivery, code, { runId: lease?.runId ?? null });
        if (lease) await store.finish(lease, "FAILED", now(), code);
        await queue.acknowledge(delivery.receipt);
      } else {
        if (lease) await store.finish(lease, "RETRY_PENDING", now(), code);
        await queue.visibility(delivery.receipt, [30, 120, 300, 900][Math.min(Math.max(delivery.receives - 1, 0), 3)]!);
      }
    } finally { await stopHeartbeat(); }
  }
}

import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { WindowedEvent } from "../contracts/analysis-event.js";
import { hash } from "./facts.js";
import { AnalysisError, type AnalysisQueue, type AnalysisScope, type AnalysisStore, type Delivery, type Lease, type Observation, type ObservationReader, type ScopeCheckpoint } from "./types.js";

export class SqsAnalysisQueue implements AnalysisQueue {
  constructor(private client: SQSClient, private url: string, private dlq: string) {}
  async receive(): Promise<Delivery[]> {
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.url, MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 300, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }));
    return (result.Messages ?? []).map(m => ({ id: m.MessageId!, receipt: m.ReceiptHandle!, body: m.Body ?? "", receives: Number(m.Attributes?.ApproximateReceiveCount ?? 1) }));
  }
  async acknowledge(receipt: string): Promise<void> { await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receipt })); }
  async visibility(receipt: string, seconds: number): Promise<void> { await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.url, ReceiptHandle: receipt, VisibilityTimeout: seconds })); }
  async deadLetter(delivery: Delivery, code: string, metadata: Record<string, unknown>): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.dlq, MessageBody: JSON.stringify({ messageId: delivery.id, bodyHash: hash(delivery.body), code, ...metadata }) }));
  }
}

type Item = Record<string, any>;
const runKey = (runId: string) => ({ pk: `ANALYSIS#RUN#${runId}`, sk: "META" });
const incidentKey = (dataset: string, id: string) => ({ pk: `DATASET#${dataset}#INCIDENT#${id}`, sk: "META" });
const day = (time: string) => time.slice(0, 10).replaceAll("-", "");
const conditional = (e: unknown) => e instanceof Error && e.name === "ConditionalCheckFailedException";

/** All publications are fenced by the current run owner and unexpired lease. */
export class DynamoAnalysisStore implements AnalysisStore, ObservationReader {
  constructor(private client: DynamoDBDocumentClient, private table: string, private valueThreshold: number) {}
  private async get(key: Item): Promise<Item | undefined> { return (await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))).Item; }
  private async query(pk: string, prefix: string): Promise<Item[]> {
    const items: Item[] = []; let cursor: Item | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      items.push(...response.Items ?? []); cursor = response.LastEvaluatedKey;
      if (items.length > 50000) throw new AnalysisError("QUERY_BUDGET_EXCEEDED", true);
    } while (cursor);
    return items;
  }
  private async write(lease: Lease, items: (Item & { createOnly?: boolean })[]): Promise<void> {
    if (items.length > 90 || items.some(i => Buffer.byteLength(JSON.stringify(i)) > 300000)) throw new AnalysisError("PERSISTENCE_BUDGET_EXCEEDED", true);
    await this.client.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.table, Key: runKey(lease.runId), ConditionExpression: "#owner = :owner AND #state = :state AND leaseUntil > :now", ExpressionAttributeNames: { "#owner": "owner", "#state": "state" }, ExpressionAttributeValues: { ":owner": lease.owner, ":state": "PROCESSING", ":now": Date.now() } } },
      ...items.map(raw => { const { createOnly, ...Item } = raw; return { Put: { TableName: this.table, Item, ...(createOnly ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) } }; }),
    ] }));
  }
  async acquire(runId: string, owner: string, now: number, leaseMs: number, fingerprint: string): Promise<"acquired" | "busy" | "complete"> {
    const key = runKey(runId), prior = await this.get(key);
    if (prior && prior.fingerprint !== fingerprint) throw new AnalysisError("IDEMPOTENCY_PAYLOAD_CONFLICT", true);
    if (prior && ["SUCCEEDED", "FAILED"].includes(prior.state)) return "complete";
    try {
      await this.client.send(new UpdateCommand({ TableName: this.table, Key: key,
        UpdateExpression: "SET #state = :processing, #owner = :owner, leaseUntil = :until, fingerprint = :fingerprint, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(pk) OR (fingerprint = :fingerprint AND (#state = :retry OR (#state = :processing AND leaseUntil <= :now)))",
        ExpressionAttributeNames: { "#state": "state", "#owner": "owner" },
        ExpressionAttributeValues: { ":processing": "PROCESSING", ":retry": "RETRY_PENDING", ":owner": owner, ":until": now + leaseMs, ":fingerprint": fingerprint, ":now": now } }));
      return "acquired";
    } catch (error) { if (conditional(error)) return "busy"; throw error; }
  }
  async renew(lease: Lease, now: number, leaseMs: number): Promise<void> {
    try { await this.client.send(new UpdateCommand({ TableName: this.table, Key: runKey(lease.runId), UpdateExpression: "SET leaseUntil = :until",
      ConditionExpression: "#owner = :owner AND #state = :state AND leaseUntil > :now", ExpressionAttributeNames: { "#owner": "owner", "#state": "state" },
      ExpressionAttributeValues: { ":owner": lease.owner, ":state": "PROCESSING", ":now": now, ":until": now + leaseMs } })); }
    catch (error) { if (conditional(error)) throw new AnalysisError("LEASE_LOST"); throw error; }
  }
  async finish(lease: Lease, state: "SUCCEEDED" | "RETRY_PENDING" | "FAILED", now: number, code?: string): Promise<void> {
    await this.client.send(new UpdateCommand({ TableName: this.table, Key: runKey(lease.runId), UpdateExpression: "SET #state = :state, updatedAt = :now, failureCode = :code",
      ConditionExpression: "#owner = :owner AND #state = :processing AND leaseUntil > :now", ExpressionAttributeNames: { "#owner": "owner", "#state": "state" },
      ExpressionAttributeValues: { ":owner": lease.owner, ":state": state, ":processing": "PROCESSING", ":now": now, ":code": code ?? null } }));
  }
  async checkpoint(lease: Lease, scopeId: string): Promise<ScopeCheckpoint | null> { return (await this.get({ pk: runKey(lease.runId).pk, sk: `SCOPE#${scopeId}` }))?.checkpoint ?? null; }
  async saveCheckpoint(lease: Lease, scopeId: string, checkpoint: ScopeCheckpoint): Promise<void> { await this.write(lease, [{ pk: runKey(lease.runId).pk, sk: `SCOPE#${scopeId}`, checkpoint }]); }
  async resolveIncident(id: string): Promise<{ event: WindowedEvent; scope: AnalysisScope; incidentId: string }> {
    const item = await this.get({ pk: `ANALYSIS#INCIDENT#${id}`, sk: "META" });
    if (!item) throw new AnalysisError("INCIDENT_NOT_FOUND", true);
    return { event: item.event, scope: item.scope, incidentId: id };
  }
  async correlate(lease: Lease, event: WindowedEvent, scope: AnalysisScope, correlationMs: number): Promise<{ incidentId: string; isNew: boolean }> {
    const key = { pk: `DATASET#${event.payload.datasetVersion}#CORRELATION#${scope.id}`, sk: "META" };
    const prior = await this.get(key), start = Date.parse(event.payload.window.start);
    if (prior && start >= (prior.lastSeen ?? prior.start) && start - (prior.lastSeen ?? prior.start) < correlationMs) {
      const existing = await this.get(incidentKey(event.payload.datasetVersion, prior.incidentId));
      if (existing && !["closed", "resolved"].includes(existing.status)) {
        await this.write(lease, [{ ...key, incidentId: prior.incidentId, start: prior.start, lastSeen: start }, { ...existing, lastObservedAt: event.payload.window.end }]);
        return { incidentId: prior.incidentId, isNew: false };
      }
    }
    // Deterministic time buckets make concurrent deliveries converge without overwriting human reviews.
    const id = `inc_${hash({ dataset: event.payload.datasetVersion, scope: scope.id, bucket: Math.floor(start / correlationMs) }).slice(0, 32)}`;
    const existing = await this.get(incidentKey(event.payload.datasetVersion, id));
    const actualId = existing && ["closed", "resolved"].includes(existing.status) ? `${id}_${lease.runId.slice(0, 8)}` : id;
    const actualExisting = actualId === id ? existing : await this.get(incidentKey(event.payload.datasetVersion, actualId));
    const item = { ...incidentKey(event.payload.datasetVersion, actualId), itemType: "incident", id: actualId, incidentId: actualId, trace_id: actualId,
      title: `Desvio observado em ${scope.entity}`, priority: scope.priority, status: "detected", startedAt: event.payload.window.start,
      lastObservedAt: event.payload.window.end, datasetVersion: event.payload.datasetVersion, scopeId: scope.id, reviewVersion: 0 };
    await this.write(lease, [
      ...(!actualExisting ? [{ ...item, createOnly: true }] : []),
      { ...key, incidentId: actualId, start, lastSeen: start },
      { pk: `ANALYSIS#INCIDENT#${actualId}`, sk: "META", event, scope },
      ...(!actualExisting ? [{ ...item, pk: `DATASET#${event.payload.datasetVersion}#VIEW#INCIDENTS#DAY#${day(event.payload.window.start)}`, sk: `OPENED#${start}#${actualId}`, trace_id: undefined }] : []),
    ]);
    return { incidentId: actualId, isNew: !actualExisting };
  }
  async saveResult(lease: Lease, checkpoint: ScopeCheckpoint): Promise<void> {
    const { event, scope, predictionId, incidentId, result } = checkpoint;
    const items: Item[] = [{ pk: runKey(lease.runId).pk, sk: `RESULT#${scope.id}`, result, datasetVersion: event.payload.datasetVersion }];
    if (predictionId) {
      const signal = result.signals.find(s => s.detector === "qoe-forecast")!;
      const item = { pk: `PREDICTION#${predictionId}`, sk: "META", id: predictionId, itemType: "prediction", scopeId: scope.id, datasetVersion: event.payload.datasetVersion,
        ...signal, valueThreshold: this.valueThreshold, validationStatus: "PENDING", createdAt: event.payload.window.end, analysisRunId: lease.runId };
      const old = await this.get({ pk: item.pk, sk: item.sk });
      if (!old) items.push(item,
        { ...item, pk: `DATASET#${event.payload.datasetVersion}#VIEW#PREDICTIONS#DAY#${day(event.payload.targetWindow!.start)}`, sk: `TARGET#${Date.parse(event.payload.targetWindow!.start)}#${predictionId}` },
        { ...item, pk: `DATASET#${event.payload.datasetVersion}#PREDICTIONS#${scope.id}`, sk: `TARGET#${Date.parse(event.payload.targetWindow!.start)}#${predictionId}` });
    }
    if (incidentId && checkpoint.context) items.push({ pk: incidentKey(event.payload.datasetVersion, incidentId).pk, sk: `ANALYSIS#${lease.runId}`, itemType: "analysis", trace_id: incidentId, result, contextHash: checkpoint.context.hash, createdAt: event.payload.window.end });
    await this.write(lease, items);
  }
  async saveDiagnosis(lease: Lease, checkpoint: ScopeCheckpoint): Promise<void> {
    const { incidentId, predictionId, event, context, diagnosis, diagnosticFailure } = checkpoint;
    const pk = incidentId ? incidentKey(event.payload.datasetVersion, incidentId).pk : `PREDICTION#${predictionId}`;
    const common = { ...(incidentId ? { trace_id: incidentId } : {}), analysisRunId: lease.runId, createdAt: event.producedAt };
    const items: Item[] = [{ pk, sk: `DIAGNOSIS#${lease.runId}`, ...common, itemType: "diagnosis", status: diagnosis ? "ready" : "failed", diagnosis: diagnosis ?? null, failureCode: diagnosticFailure ?? null, contextHash: context?.hash }];
    for (const fact of context?.facts ?? []) items.push({ pk, sk: `EVIDENCE#${fact.id}`, ...common, itemType: "evidence", ...fact, description: fact.statement });
    for (const hypothesis of diagnosis?.hypotheses ?? []) {
      const id = `${lease.runId.slice(0, 16)}_${hypothesis.id}`;
      const key = { pk, sk: `HYPOTHESIS#${id}` };
      if (!await this.get(key)) items.push({ ...key, ...common, itemType: "hypothesis", ...hypothesis, id, statement: hypothesis.title, rationale: hypothesis.explanation, probability: null, createOnly: true });
    }
    await this.write(lease, items);
  }
  async validatePredictions(lease: Lease, event: WindowedEvent, scope: AnalysisScope, rows: Observation[], toleranceMs: number): Promise<void> {
    if (event.eventType !== "QOE_FORECAST") return;
    const items = await this.query(`DATASET#${event.payload.datasetVersion}#PREDICTIONS#${scope.id}`, "TARGET#");
    for (const item of items.filter(i => i.validationStatus === "PENDING" && Date.parse(i.targetWindow.end) <= Date.parse(event.payload.window.end))) {
      const actual = rows.find(r => r.metric === "bufferratio_avg" && r.grainSeconds === 3600 && Date.parse(r.timestamp) === Date.parse(item.targetWindow.start));
      if (actual?.value == null && Date.parse(event.payload.window.end) < Date.parse(item.targetWindow.end) + toleranceMs) continue;
      const positive = item.score > item.threshold.value, observed = actual?.value == null ? null : actual.value > item.valueThreshold;
      const status = observed === null ? "UNKNOWN" : positive ? observed ? "TP" : "FP" : observed ? "FN" : "TN";
      const updated = { ...item, validationStatus: status, observedValue: actual?.value ?? null, validatedAt: event.payload.window.end };
      await this.write(lease, [updated, { ...updated, pk: `PREDICTION#${item.id}`, sk: "META" },
        { ...updated, pk: `DATASET#${event.payload.datasetVersion}#VIEW#PREDICTIONS#DAY#${day(item.targetWindow.start)}` }]);
    }
  }
  async read(event: WindowedEvent, scope: AnalysisScope, from: string): Promise<Observation[]> {
    const rows: Observation[] = [], cutoff = Date.parse(event.payload.window.end);
    for (const series of scope.series) for (let at = Math.floor(Date.parse(from) / 86400000) * 86400000; at < cutoff; at += 86400000) {
      const items = await this.query(`DATASET#${event.payload.datasetVersion}#FACT#TS#${series.seriesId}#${day(new Date(at).toISOString())}`, "T#");
      for (const item of items) {
        const payload = item.payload, metric = payload?.metric;
        if (item.datasetVersion !== event.payload.datasetVersion || item.seriesId !== series.seriesId || metric?.name !== series.metric || metric?.unit !== series.unit)
          throw new AnalysisError("FACT_SCHEMA_MISMATCH", true);
        rows.push({ id: item.recordId ?? item.id ?? item.sk, datasetVersion: item.datasetVersion, scopeId: scope.id, metric: metric.name,
          unit: metric.unit, timestamp: item.observedAt, grainSeconds: series.grainSeconds, value: metric.value });
        if (rows.length > 50000) throw new AnalysisError("OBSERVATION_BUDGET_EXCEEDED", true);
      }
    }
    return rows;
  }
}

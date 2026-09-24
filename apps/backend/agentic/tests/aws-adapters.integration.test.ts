import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { DynamoAnalysisStore } from "../src/worker/aws.js";
import type { AnalysisScope, Lease } from "../src/worker/types.js";
import type { WindowedEvent } from "../src/contracts/analysis-event.js";

const endpoint = process.env.DYNAMODB_ENDPOINT;

test("DynamoDB Local executa lease, leitura canônica e correlação idempotente", { skip: !endpoint }, async () => {
  const table = `analysis-contract-${randomUUID()}`;
  const raw = new DynamoDBClient({ endpoint: endpoint!, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  await raw.send(new CreateTableCommand({
    TableName: table,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  await waitUntilTableExists({ client: raw, maxWaitTime: 20 }, { TableName: table });

  try {
    const store = new DynamoAnalysisStore(client, table, 0.1);
    const now = Date.now();
    assert.equal(await store.acquire("run-contract", "owner-contract", now, 300_000, "fingerprint"), "acquired");
    const lease: Lease = { runId: "run-contract", owner: "owner-contract" };
    const scope: AnalysisScope = {
      id: "scope-contract", source: "argus", entity: "canal-contract", priority: "P2",
      detectorMetrics: ["bufferratio_avg"],
      series: [{ metric: "bufferratio_avg", seriesId: "ts_contract", unit: "ratio", grainSeconds: 900 }],
    };
    const event: WindowedEvent = {
      eventId: "evt", eventType: "ANOMALY_DETECTION", schemaVersion: "1.0", idempotencyKey: "key", traceId: "trace",
      occurredAt: "2026-09-06T15:00:00.000Z", producedAt: "2026-09-06T15:01:00.000Z", source: "ingestion",
      payload: { window: { start: "2026-09-06T14:45:00.000Z", end: "2026-09-06T15:00:00.000Z", grainSeconds: 900 }, inputWatermark: "2026-09-06T15:00:00.000Z", datasetVersion: "dsv_contract_v1" },
    };
    await client.send(new PutCommand({ TableName: table, Item: {
      pk: "DATASET#dsv_contract_v1#FACT#TS#ts_contract#20260906", sk: "T#1788705900000#rec_contract_001",
      recordId: "rec_contract_001", datasetVersion: "dsv_contract_v1", seriesId: "ts_contract", observedAt: event.payload.window.start,
      payload: { metric: { name: "bufferratio_avg", unit: "ratio", value: 0.12 } },
    } }));
    const rows = await store.read(event, scope, "2026-09-06T00:00:00.000Z");
    assert.deepEqual(rows.map(row => [row.metric, row.value]), [["bufferratio_avg", 0.12]]);

    const first = await store.correlate(lease, event, scope, 7200_000);
    assert.equal(first.isNew, true);
    const secondEvent = structuredClone(event);
    (secondEvent.payload.window as { start: string; end: string; grainSeconds: number }).start = "2026-09-06T15:00:00.000Z";
    (secondEvent.payload.window as { start: string; end: string; grainSeconds: number }).end = "2026-09-06T15:15:00.000Z";
    const second = await store.correlate(lease, secondEvent, scope, 7200_000);
    assert.deepEqual(second, { incidentId: first.incidentId, isNew: false });
    const incident = await client.send(new GetCommand({ TableName: table, Key: { pk: `DATASET#dsv_contract_v1#INCIDENT#${first.incidentId}`, sk: "META" } }));
    assert.equal(incident.Item?.lastObservedAt, "2026-09-06T15:15:00.000Z");
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: table }));
    raw.destroy();
  }
});

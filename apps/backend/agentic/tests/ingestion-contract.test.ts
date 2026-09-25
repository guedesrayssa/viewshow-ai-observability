import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, PutItemCommand, waitUntilTableExists, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { parseAnalysisEvent, type WindowedEvent } from "../src/contracts/analysis-event.js";
import { DynamoAnalysisStore } from "../src/worker/aws.js";
import { cleanObservations } from "../src/worker/facts.js";
import { infer, type ModelBundle } from "../src/worker/models.js";
import { validateWindow } from "../src/worker/orchestrator.js";
import type { AnalysisScope } from "../src/worker/types.js";

// Arquivos gerados pelo código de ingestão (tests/contracts/test_worker_contract.py).
// Se a ingestão mudar o que grava ou publica, regenere-os e rode este teste de novo.
const endpoint = process.env.DYNAMODB_ENDPOINT;
const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));

const bundle: ModelBundle = {
  schemaVersion: "analysis-models-v1", name: "qoe-random-forest", version: "candidate", approved: true,
  approval: { reference: "test", sourceSha256: "a".repeat(64), approvedAt: "2025-01-02T00:00:00Z" },
  trainedThrough: "2025-01-01T00:00:00Z", datasetVersion: "dsv_contract_v1",
  features: ["bufferratio_avg", "lag_1h", "lag_2h", "lag_3h", "roll_mean_3h", "sessions", "errors", "startup_errors", "hora_sin", "hora_cos", "dia_semana"],
  forecast: { trees: [{ left: [-1], right: [-1], feature: [-2], threshold: [-2], value: [.1] }], calibration: { x: [0, 1], y: [0, 1] }, valueThreshold: .5, riskThreshold: .5, highRiskThreshold: .8 },
  detection: { robustThreshold: 3.5, minHistoryDays: 3, minHistoryPoints: 96, scopes: {} },
};

async function ingestionEvent(kind: "ANOMALY_DETECTION" | "QOE_FORECAST"): Promise<WindowedEvent> {
  const golden = await readJson("contracts/fixtures/ingestion-events.v1.json");
  const parsed = parseAnalysisEvent(golden.events[kind]);
  assert.ok(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.metadata.failures));
  assert.equal(parsed.event.eventType, kind);
  return parsed.event as WindowedEvent;
}

async function pilotScope(id: string): Promise<AnalysisScope> {
  const catalog = await readJson("config/scope-catalog.pilot.json") as AnalysisScope[];
  const scope = catalog.find(candidate => candidate.id === id);
  assert.ok(scope, `escopo ${id} ausente do catálogo piloto`);
  return scope;
}

test("eventos publicados pela ingestão satisfazem o parser e a janela do worker", async () => {
  for (const kind of ["ANOMALY_DETECTION", "QOE_FORECAST"] as const) {
    const event = await ingestionEvent(kind);
    assert.doesNotThrow(() => validateWindow(event));
    assert.equal(event.payload.scope?.kind, "global");
  }
});

test("a identidade do modelo no evento de previsão é a que o bundle exige", async () => {
  const golden = await readJson("contracts/fixtures/ingestion-events.v1.json");
  const event = await ingestionEvent("QOE_FORECAST");
  const scope = await pilotScope((await readJson("contracts/fixtures/ingestion-facts.v1.json")).scopeId);
  assert.deepEqual(event.payload.model, golden.forecastModel);

  const accepted = infer({ ...bundle, name: golden.forecastModel.name, version: golden.forecastModel.version }, event, scope, []);
  assert.deepEqual(accepted.reasons, ["FORECAST_FEATURES_INCOMPLETE"]);
  assert.throws(() => infer({ ...bundle, version: "outra-versao" }, event, scope, []), /MODEL_VERSION_MISMATCH/);
});

test("fatos gravados pela ingestão são lidos pelo adaptador do worker no DynamoDB Local", { skip: !endpoint }, async () => {
  const golden = await readJson("contracts/fixtures/ingestion-facts.v1.json");
  const scope = await pilotScope(golden.scopeId);
  const event = await ingestionEvent("ANOMALY_DETECTION");
  assert.equal(event.payload.datasetVersion, golden.datasetVersion);

  const table = `ingestion-contract-${randomUUID()}`;
  const raw = new DynamoDBClient({ endpoint: endpoint!, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  await raw.send(new CreateTableCommand({
    TableName: table,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  try {
    await waitUntilTableExists({ client: raw, minDelay: 1, maxDelay: 2, maxWaitTime: 20 }, { TableName: table });
    // Os itens do arquivo estão na forma tipada do DynamoDB, exatamente como a ingestão os envia.
    for (const item of golden.items as Record<string, AttributeValue>[]) await raw.send(new PutItemCommand({ TableName: table, Item: item }));

    const from = "2026-09-06T00:00:00.000Z";
    const rows = await new DynamoAnalysisStore(client, table, 0.1).read(event, scope, from);
    assert.equal(rows.length, scope.series.length);
    for (const series of scope.series) {
      const stored = (golden.items as any[]).find(item => item.seriesId.S === series.seriesId);
      assert.ok(stored, `a ingestão não gravou a série ${series.metric}`);
      const row = rows.find(candidate => candidate.metric === series.metric && candidate.grainSeconds === series.grainSeconds);
      assert.ok(row, `o worker não leu a série ${series.metric}/${series.grainSeconds}`);
      assert.equal(row.unit, series.unit);
      assert.equal(row.timestamp, stored.observedAt.S);
      assert.equal(row.value, Number(stored.payload.M.metric.M.value.N));
    }
    assert.equal(cleanObservations(rows, golden.datasetVersion, scope, Date.parse(from), Date.parse(event.payload.window.end)).length, rows.length);
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: table }));
    raw.destroy();
  }
});

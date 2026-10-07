import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { catalogSeriesIds, requireDemoSeedEnvironment } from "./demo-seed-support.mjs";

const {
  OPERATIONAL_TABLE_NAME: table,
  ANALYSIS_QUEUE_URL: queueUrl,
  INCIDENT_ID: incidentId,
} = requireDemoSeedEnvironment(["OPERATIONAL_TABLE_NAME", "ANALYSIS_QUEUE_URL", "INCIDENT_ID"]);
const region = process.env.AWS_REGION ?? "us-east-1";
const scopeId = "canal-demo";
const seriesIds = catalogSeriesIds(
  new URL("../config/scope-catalog.frontend-demo.json", import.meta.url),
  scopeId,
);
const cutoff = Date.parse("2026-09-28T18:00:00.000Z");
const grainMs = 15 * 60 * 1000;
const definitions = [
  {
    metric: "latency_ms_p95",
    seriesId: seriesIds.latency_ms_p95,
    unit: "milliseconds",
    baseline: (point) => point % 2 ? 180 : 220,
    anomaly: [820, 855, 890, 925],
  },
  {
    metric: "errors",
    seriesId: seriesIds.errors,
    unit: "count",
    baseline: (point) => point % 2 ? 8 : 12,
    anomaly: [73, 77, 81, 65],
  },
  {
    metric: "sessions",
    seriesId: seriesIds.sessions,
    unit: "count",
    baseline: (point) => 820 + (point % 6) * 18,
    anomaly: [868, 890, 912, 934],
  },
];
const presentationDefinitions = [
  {
    metric: "affected_devices",
    seriesId: seriesIds.affected_devices,
    unit: "devices",
    values: [2, 2, 2, 3, 3, 4, 5, 5],
  },
  {
    metric: "bufferratio_avg",
    seriesId: seriesIds.bufferratio_avg,
    unit: "ratio",
    values: [0.007, 0.009, 0.012, 0.016, 0.024, 0.035, 0.046, 0.041],
  },
  {
    metric: "errors_model_a",
    seriesId: seriesIds.errors_model_a,
    unit: "count",
    values: [3, 4, 5, 5, 11, 14, 17, 19],
  },
  {
    metric: "errors_model_b",
    seriesId: seriesIds.errors_model_b,
    unit: "count",
    values: [2, 2, 2, 3, 5, 6, 7, 8],
  },
  {
    metric: "errors_model_c",
    seriesId: seriesIds.errors_model_c,
    unit: "count",
    values: [1, 1, 1, 1, 2, 2, 2, 3],
  },
];

const day = (timestamp) =>
  new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");

function fact(datasetVersion, definition, timestamp, value) {
  const observedAt = new Date(timestamp).toISOString();
  const recordId = `fact_frontend_${createHash("sha256")
    .update(`${definition.metric}:${observedAt}`)
    .digest("hex")}`;
  return {
    pk: `DATASET#${datasetVersion}#FACT#TS#${definition.seriesId}#${day(timestamp)}`,
    sk: `T#${timestamp}#${recordId}`,
    itemType: "time-series-fact",
    recordId,
    datasetVersion,
    seriesId: definition.seriesId,
    observedAt,
    grainSeconds: 900,
    source: "synthetic-qoe",
    entity: "canal-demo",
    dimensions: { channel: "canal-demo", demo: "true" },
    payload: {
      metric: { name: definition.metric, unit: definition.unit, value },
    },
  };
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const active = await dynamo.send(new GetCommand({
  TableName: table,
  Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
  ConsistentRead: true,
}));
const datasetVersion = active.Item?.activeDatasetVersion;
if (typeof datasetVersion !== "string") throw new Error("active dataset not found");

const items = [];
for (const definition of definitions) {
  for (let point = 7 * 96; point > 4; point -= 1) {
    const timestamp = cutoff - point * grainMs;
    items.push(fact(
      datasetVersion,
      definition,
      timestamp,
      definition.baseline(point),
    ));
  }
  for (let index = 0; index < 4; index += 1) {
    const timestamp = cutoff - (4 - index) * grainMs;
    items.push(fact(
      datasetVersion,
      definition,
      timestamp,
      definition.anomaly[index],
    ));
  }
}
for (const definition of presentationDefinitions) {
  for (const [index, value] of definition.values.entries()) {
    const timestamp = cutoff - (definition.values.length - index) * grainMs;
    items.push(fact(datasetVersion, definition, timestamp, value));
  }
}

for (let offset = 0; offset < items.length; offset += 25) {
  let pending = items
    .slice(offset, offset + 25)
    .map((Item) => ({ PutRequest: { Item } }));
  do {
    const response = await dynamo.send(new BatchWriteCommand({
      RequestItems: { [table]: pending },
    }));
    pending = response.UnprocessedItems?.[table] ?? [];
    if (pending.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 250));
  } while (pending.length > 0);
}

const now = new Date().toISOString();
const id = randomUUID();
const event = {
  eventId: `evt_${id}`,
  eventType: "REANALYSIS_REQUESTED",
  schemaVersion: "1.0",
  idempotencyKey: `frontend-demo-${incidentId}-${id}`,
  traceId: `trc_${id}`,
  occurredAt: now,
  producedAt: now,
  source: "frontend-demo-seed",
  payload: {
    incidentId,
    requestedBy: "demo-validation",
    reason: "MANUAL_REQUEST",
  },
};
const sent = await new SQSClient({ region }).send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(event),
}));
process.stdout.write(`${JSON.stringify({
  datasetVersion,
  incidentId,
  factsWritten: items.length,
  messageId: sent.MessageId,
})}\n`);

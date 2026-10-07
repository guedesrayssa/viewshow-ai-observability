import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { catalogSeriesIds, requireDemoSeedEnvironment } from "./demo-seed-support.mjs";

const {
  OPERATIONAL_TABLE_NAME: table,
  ANALYSIS_QUEUE_URL: queueUrl,
  DATASET_VERSION: datasetVersion,
} = requireDemoSeedEnvironment(["OPERATIONAL_TABLE_NAME", "ANALYSIS_QUEUE_URL", "DATASET_VERSION"]);
const region = process.env.AWS_REGION ?? "us-east-1";
const scopeId = "canal-e2e-demo-agentico";
const seriesId = catalogSeriesIds(
  new URL("../config/scope-catalog.demo.json", import.meta.url),
  scopeId,
).bufferratio_avg;
const windowStart = Date.parse("2026-09-28T17:00:00.000Z");
const grainMs = 15 * 60 * 1000;

const day = (timestamp) => new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
const fact = (timestamp, value, label) => {
  const observedAt = new Date(timestamp).toISOString();
  const recordId = `fact_demo_${createHash("sha256").update(`${label}:${observedAt}`).digest("hex")}`;
  return {
    pk: `DATASET#${datasetVersion}#FACT#TS#${seriesId}#${day(timestamp)}`,
    sk: `T#${timestamp}#${recordId}`,
    itemType: "time-series-fact",
    recordId,
    datasetVersion,
    seriesId,
    observedAt,
    grainSeconds: 900,
    source: "synthetic-demo",
    entity: scopeId,
    dimensions: { channel: scopeId, demo: "true" },
    payload: { metric: { name: "bufferratio_avg", unit: "ratio", value } },
  };
};

const items = [];
for (let point = 7 * 96; point > 0; point -= 1) {
  items.push(fact(windowStart - point * grainMs, point % 2 ? 1 : 1.2, "history"));
}
items.push(fact(windowStart, 4, "controlled-anomaly"));

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
for (let offset = 0; offset < items.length; offset += 25) {
  let pending = items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } }));
  do {
    const response = await dynamo.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
    pending = response.UnprocessedItems?.[table] ?? [];
    if (pending.length) await new Promise((resolve) => setTimeout(resolve, 250));
  } while (pending.length);
}

const event = {
  eventId: "evt_demo_agentic_20260928_1700",
  eventType: "ANOMALY_DETECTION",
  schemaVersion: "1.0",
  idempotencyKey: "demo-agentic-20260928-1700-v1",
  traceId: "trc_demo_agentic_20260928_1700",
  occurredAt: "2026-09-28T17:15:00.000Z",
  producedAt: new Date().toISOString(),
  source: "synthetic-demo-authorized",
  payload: {
    window: {
      start: "2026-09-28T17:00:00.000Z",
      end: "2026-09-28T17:15:00.000Z",
      grainSeconds: 900,
    },
    scope: { kind: "channel", dimensions: { scopeId } },
    inputWatermark: "2026-09-28T17:15:00.000Z",
    datasetVersion,
  },
};
const sent = await new SQSClient({ region }).send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(event),
}));
process.stdout.write(`${JSON.stringify({ factsWritten: items.length, messageId: sent.MessageId, event }, null, 2)}\n`);

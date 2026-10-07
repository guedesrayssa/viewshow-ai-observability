import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { catalogSeriesIds, requireDemoSeedEnvironment } from "./demo-seed-support.mjs";

const {
  OPERATIONAL_TABLE_NAME: table,
  ANALYSIS_QUEUE_URL: queueUrl,
  INCIDENT_ID: incidentId,
} = requireDemoSeedEnvironment(["OPERATIONAL_TABLE_NAME", "ANALYSIS_QUEUE_URL", "INCIDENT_ID"]);
const region = process.env.AWS_REGION ?? "us-east-1";
const scopeId = "fixture-edge-b";
const seriesIds = catalogSeriesIds(
  new URL("../config/scope-catalog.frontend-demo.json", import.meta.url),
  scopeId,
);
const trigger = {
  source: "prometheus",
  entity: "edge-b",
  metric: "latency",
  grainSeconds: 900,
};
const latencyDefinition = {
  metric: "latency_ms_p95",
  seriesId: seriesIds.latency_ms_p95,
  unit: "milliseconds",
};
const presentationDefinitions = [
  {
    metric: "affected_devices",
    seriesId: seriesIds.affected_devices,
    unit: "devices",
    values: [1, 1, 1, 1, 2, 2, 3, 3],
  },
  {
    metric: "bufferratio_avg",
    seriesId: seriesIds.bufferratio_avg,
    unit: "ratio",
    values: [0.008, 0.009, 0.011, 0.014, 0.021, 0.032, 0.04, 0.036],
  },
  {
    metric: "errors_model_a",
    seriesId: seriesIds.errors_model_a,
    unit: "count",
    values: [4, 5, 6, 5, 12, 14, 16, 18],
  },
  {
    metric: "errors_model_b",
    seriesId: seriesIds.errors_model_b,
    unit: "count",
    values: [2, 2, 3, 3, 6, 6, 7, 7],
  },
  {
    metric: "errors_model_c",
    seriesId: seriesIds.errors_model_c,
    unit: "count",
    values: [1, 1, 1, 1, 2, 2, 2, 2],
  },
];
const grainMs = trigger.grainSeconds * 1000;

const day = (timestamp) =>
  new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");

function fact(datasetVersion, definition, timestamp, value) {
  const observedAt = new Date(timestamp).toISOString();
  const recordId = `fact_fixture_${createHash("sha256")
    .update(`${incidentId}:${definition.metric}:${observedAt}`)
    .digest("hex")}`;
  return {
    pk: `DATASET#${datasetVersion}#FACT#TS#${definition.seriesId}#${day(timestamp)}`,
    sk: `T#${timestamp}#${recordId}`,
    itemType: "time-series-fact",
    recordId,
    datasetVersion,
    seriesId: definition.seriesId,
    observedAt,
    grainSeconds: trigger.grainSeconds,
    source: "synthetic-fixture",
    entity: trigger.entity,
    dimensions: {
      fixture: "INC-FIXTURE-001",
      synthetic: "true",
      triggerSource: trigger.source,
    },
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

const incidentEvents = await dynamo.send(new QueryCommand({
  TableName: table,
  KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
  ExpressionAttributeValues: {
    ":pk": `DATASET#${datasetVersion}#INCIDENT#${incidentId}`,
    ":prefix": "EVENT#",
  },
  ConsistentRead: true,
}));
const matched = (incidentEvents.Items ?? []).flatMap((item) => {
  const payload = item.payload;
  const dimensions = payload?.dimensions;
  const window = payload?.window;
  return item.entityType === "INCIDENT_EVENT" &&
    payload?.category === "signal_observation" &&
    dimensions?.source === trigger.source &&
    dimensions?.entity === trigger.entity &&
    dimensions?.metric === trigger.metric &&
    window?.grainSeconds === trigger.grainSeconds &&
    typeof window?.start === "string" &&
    typeof window?.end === "string"
    ? [{ window }]
    : [];
}).sort((left, right) => Date.parse(right.window.end) - Date.parse(left.window.end));
if (!matched.length) throw new Error("fixture trigger event not found in active dataset");

const cutoff = Date.parse(matched[0].window.end);
if (!Number.isFinite(cutoff) || cutoff % grainMs !== 0)
  throw new Error("fixture trigger window is not aligned");

const items = [];
const baseline = [180, 195, 205, 220];
for (let point = 7 * 96; point > 4; point -= 1) {
  const timestamp = cutoff - point * grainMs;
  items.push(fact(datasetVersion, latencyDefinition, timestamp, baseline[point % baseline.length]));
}
for (const [index, value] of [820, 855, 890, 925].entries()) {
  const timestamp = cutoff - (4 - index) * grainMs;
  items.push(fact(datasetVersion, latencyDefinition, timestamp, value));
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
const requestId = randomUUID();
const event = {
  eventId: `evt_${requestId}`,
  eventType: "REANALYSIS_REQUESTED",
  schemaVersion: "1.0",
  idempotencyKey: `fixture-analysis-${incidentId}-${requestId}`,
  traceId: `trc_${requestId}`,
  occurredAt: now,
  producedAt: now,
  source: "fixture-analysis-seed",
  payload: {
    incidentId,
    requestedBy: "integration-validation",
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
  scopeId,
  factsWritten: items.length,
  triggerWindow: matched[0].window,
  messageId: sent.MessageId,
})}\n`);

import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const region = process.env.AWS_REGION ?? "us-east-1";
const table = process.env.OPERATIONAL_TABLE_NAME ?? "view-show-iac-operacional";
const queueUrl = process.env.ANALYSIS_QUEUE_URL ??
  "https://sqs.us-east-1.amazonaws.com/410685407336/view-show-ingestion-analysis";
const incidentId = process.env.INCIDENT_ID ?? "inc_32rewksgztyriiuenlgj3drbpx";
const scopeId = "fixture-edge-b";
const trigger = {
  source: "prometheus",
  entity: "edge-b",
  metric: "latency",
  grainSeconds: 900,
};
const latencyDefinition = {
  metric: "latency_ms_p95",
  seriesId: "ts_fixture_edge_b_latency_p95_15m",
  unit: "milliseconds",
};
const presentationDefinitions = [
  {
    metric: "affected_devices",
    seriesId: "ts_fixture_affected_devices_15m",
    unit: "devices",
    values: [1, 1, 1, 1, 2, 2, 3, 3],
  },
  {
    metric: "bufferratio_avg",
    seriesId: "ts_fixture_edge_b_bufferratio_15m",
    unit: "ratio",
    values: [0.008, 0.009, 0.011, 0.014, 0.021, 0.032, 0.04, 0.036],
  },
  {
    metric: "errors_model_a",
    seriesId: "ts_fixture_model_a_errors_15m",
    unit: "count",
    values: [4, 5, 6, 5, 12, 14, 16, 18],
  },
  {
    metric: "errors_model_b",
    seriesId: "ts_fixture_model_b_errors_15m",
    unit: "count",
    values: [2, 2, 3, 3, 6, 6, 7, 7],
  },
  {
    metric: "errors_model_c",
    seriesId: "ts_fixture_model_c_errors_15m",
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

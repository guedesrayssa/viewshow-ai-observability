import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const region = "us-east-1";
const table = "view-show-iac-operacional";
const datasetVersion = "dsv_9c534268841ba53fe0dd977d91a0f995b2124bcb7a176aa54b2cabbefd130697";
const incidentId = "inc_a229cf05afa6e42a1e99c53ab6e7b89d";
const key = {
  pk: `DATASET#${datasetVersion}#VIEW#INCIDENTS#ACTIVE`,
  sk: "CURRENT",
};
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const response = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
if (!response.Item) throw new Error("active incident projection not found");

const incidents = response.Item.payload?.incidents;
if (!Array.isArray(incidents)) throw new Error("active incident projection has no incident array");
const demo = {
  incidentId,
  number: "DEMO-AGENT-001",
  openedAt: "2026-09-28T17:00:00.000Z",
  state: "investigating",
  priority: "P2",
};
const nextIncidents = [demo, ...incidents.filter((item) => item?.incidentId !== incidentId)];
const payload = {
  ...response.Item.payload,
  observedThrough: "2026-09-28T17:15:00.000Z",
  coverage: "partial",
  qualityFlags: [...new Set([...(response.Item.payload.qualityFlags ?? []), "SYNTHETIC_DEMO"] )],
  incidents: nextIncidents,
};
const payloadFingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
await client.send(new PutCommand({
  TableName: table,
  Item: { ...response.Item, payload, payloadFingerprint },
  ConditionExpression: "materializationRevision = :revision",
  ExpressionAttributeValues: { ":revision": response.Item.materializationRevision },
}));
process.stdout.write(`${JSON.stringify({ published: true, incidentId, number: demo.number, total: nextIncidents.length })}\n`);

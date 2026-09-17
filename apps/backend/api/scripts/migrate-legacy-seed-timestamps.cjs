// Fixes incidents written by the old load seed with a relative timestamp.
// Their original seed time is recoverable from the 30-day TTL on each item.
const { writeFileSync } = require("node:fs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const region = process.env.AWS_REGION || "us-east-1";
const table = process.env.OPERATIONAL_TABLE_NAME;
const backup = process.env.MIGRATION_BACKUP_FILE;
if (!table || !backup || process.env.ALLOW_REMOTE_SEED !== "1") {
  throw new Error("OPERATIONAL_TABLE_NAME, MIGRATION_BACKUP_FILE e ALLOW_REMOTE_SEED=1 são obrigatórios.");
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const ttlSeconds = 30 * 24 * 60 * 60;

function originalStart(item) {
  if (!Number.isInteger(item.ttl) || !Number.isInteger(item.startedMinutesAgo)) return null;
  const timestamp = new Date((item.ttl - ttlSeconds) * 1000 - item.startedMinutesAgo * 60_000);
  const bucket = `INC#${timestamp.toISOString().slice(0, 13)}`;
  return bucket === item.pk ? timestamp.toISOString() : null;
}

async function main() {
  const scanned = [];
  let startKey;
  do {
    const response = await client.send(new ScanCommand({
      TableName: table,
      FilterExpression: "begins_with(sk, :prefix) AND attribute_exists(startedMinutesAgo) AND attribute_not_exists(startedAt)",
      ExpressionAttributeValues: { ":prefix": "INCIDENT#" },
      ExclusiveStartKey: startKey,
    }));
    scanned.push(...(response.Items || []));
    startKey = response.LastEvaluatedKey;
  } while (startKey);

  const oldestHour = Date.now() - 25 * 60 * 60_000;
  const candidates = scanned.filter((item) =>
    /^INCIDENT#inc-\d{6}$/.test(item.sk)
      && /^INC#\d{4}-\d{2}-\d{2}T\d{2}$/.test(item.pk)
      && new Date(`${item.pk.slice(4)}:00:00Z`).getTime() >= oldestHour,
  );
  const updates = candidates.map((item) => ({ item, startedAt: originalStart(item) }));
  const invalid = updates.filter((update) => !update.startedAt);
  if (invalid.length) throw new Error(`${invalid.length} timestamps não puderam ser inferidos; nenhuma escrita foi feita.`);
  writeFileSync(backup, JSON.stringify(candidates, null, 2));
  console.log(`${updates.length} incidentes legados recentes encontrados de ${scanned.length} registros; backup gravado.`);
  if (process.env.MIGRATION_DRY_RUN === "1") return;
  for (let offset = 0; offset < updates.length; offset += 5) {
    await Promise.all(updates.slice(offset, offset + 5).map(({ item, startedAt }) => client.send(new UpdateCommand({
      TableName: table,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET startedAt = :startedAt",
      ConditionExpression: "attribute_not_exists(startedAt)",
      ExpressionAttributeValues: { ":startedAt": startedAt },
    }))));
  }
  console.log(`${updates.length} horários absolutos persistidos.`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { originalStart };

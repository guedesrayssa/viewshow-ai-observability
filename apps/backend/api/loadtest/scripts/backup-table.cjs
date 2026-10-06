/**
 * Backup completo (somente leitura) da tabela operacional em um JSON, com um censo de
 * prefixos de chave. Tire-o ANTES de qualquer seed remoto: `undo-remote-seed.cjs` usa
 * este arquivo para restaurar o manifesto ativo e separar o que é sintético.
 *
 * USO (a partir de apps/backend/api):
 *   OPERATIONAL_TABLE_NAME=<tabela> AWS_REGION=us-east-1 \
 *     node loadtest/scripts/backup-table.cjs <saida.json>
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const fs = require("fs");
const table = process.env.OPERATIONAL_TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }));
(async () => {
  let key; const items = [];
  do {
    const r = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    items.push(...(r.Items || [])); key = r.LastEvaluatedKey;
  } while (key);
  fs.writeFileSync(process.argv[2], JSON.stringify(items));
  const census = {};
  for (const it of items) { const p = String(it.pk).split("#").slice(0, 2).join("#").replace(/dsv_[0-9a-f]+/, "dsv_*"); census[p] = (census[p] || 0) + 1; }
  console.log("itens:", items.length, "bytes json:", fs.statSync(process.argv[2]).size);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(census).sort((a, b) => b[1] - a[1]).slice(0, 25)), null, 1));
  const ctl = items.filter((i) => i.pk === "CONTROL#DATASET");
  console.log("itens CONTROL#DATASET:", ctl.map((i) => `${i.sk} -> ${i.activeDatasetVersion || ""}`).join(" | "));
})().catch((e) => { console.error(e.name, e.message); process.exit(1); });

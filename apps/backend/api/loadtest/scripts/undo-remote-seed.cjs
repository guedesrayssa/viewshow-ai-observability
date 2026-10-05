/**
 * Desfaz um `seed-carga.cjs` feito em uma tabela REMOTA que já tinha dados reais.
 *
 * O seed grava o manifesto `CONTROL#DATASET/ACTIVE` (troca o dataset ativo) e itens
 * sintéticos (`INC#*`, `VIEW#*` e as versões de dataset `seed-carga-1.0`). O `CLEAN=1`
 * do seed recusa tabelas remotas, então este script faz o caminho de volta a partir de
 * um backup tirado ANTES do seed (scan completo em JSON):
 *
 *   1. restaura o item `CONTROL#DATASET/ACTIVE` do backup;
 *   2. apaga somente os itens sintéticos.
 *
 * Trava: nenhuma chave presente no backup é apagada, e nada fora de `INC#`, `VIEW#` e
 * `DATASET#<versão seed-carga>#` é tocado. Sem `--apply` é só ensaio (nenhuma escrita).
 *
 * USO (a partir de apps/backend/api):
 *   OPERATIONAL_TABLE_NAME=<tabela> AWS_REGION=us-east-1 \
 *     node loadtest/scripts/undo-remote-seed.cjs <backup.json> [--apply]
 */
const fs = require("node:fs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const backupFile = process.argv[2];
const apply = process.argv.includes("--apply");
const table = process.env.OPERATIONAL_TABLE_NAME;
if (!backupFile || !table)
  throw new Error("Informe o backup (argumento 1) e OPERATIONAL_TABLE_NAME.");

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
);
const key = (item) => `${item.pk}|${item.sk}`;

async function scanAll() {
  const items = [];
  let start;
  do {
    const page = await client.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: start }),
    );
    items.push(...(page.Items || []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

async function main() {
  const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  const backupKeys = new Set(backup.map(key));
  const originalActive = backup.find(
    (item) => item.pk === "CONTROL#DATASET" && item.sk === "ACTIVE",
  );
  if (!originalActive)
    throw new Error("O backup não tem CONTROL#DATASET/ACTIVE; recuse restaurar.");
  if (
    originalActive.manifest?.metadata?.formulaVersions?.incidents ===
    "seed-carga-1.0"
  )
    throw new Error("O manifesto do backup já é de seed; backup errado.");
  if (backup.some((item) => /^(INC|VIEW)#/.test(String(item.pk))))
    throw new Error(
      "O backup já contém itens INC#/VIEW#: não dá para separar o sintético do real.",
    );

  const current = await scanAll();
  const seedVersions = new Set();
  for (const item of current) {
    if (
      item.pk === "CONTROL#DATASET" &&
      item.sk === "ACTIVE" &&
      item.manifest?.metadata?.formulaVersions?.incidents === "seed-carga-1.0"
    )
      seedVersions.add(item.activeDatasetVersion);
    if (
      typeof item.pk === "string" &&
      item.pk.startsWith("DATASET#") &&
      item.payload?.formulaVersion === "seed-carga-1.0" &&
      typeof item.datasetVersion === "string"
    )
      seedVersions.add(item.datasetVersion);
  }
  seedVersions.delete(originalActive.activeDatasetVersion);
  const seedPrefixes = [...seedVersions].map((v) => `DATASET#${v}#`);

  const toDelete = current.filter((item) => {
    if (typeof item.pk !== "string" || typeof item.sk !== "string") return false;
    if (backupKeys.has(key(item))) return false;
    return (
      item.pk.startsWith("INC#") ||
      item.pk.startsWith("VIEW#") ||
      seedPrefixes.some((prefix) => item.pk.startsWith(prefix))
    );
  });
  for (const item of toDelete)
    if (backupKeys.has(key(item))) throw new Error("Trava: chave do backup na lista.");

  const active = current.find(
    (item) => item.pk === "CONTROL#DATASET" && item.sk === "ACTIVE",
  );
  console.log(`Tabela: ${table}`);
  console.log(`Manifesto ativo atual : ${active?.activeDatasetVersion}`);
  console.log(`Manifesto do backup   : ${originalActive.activeDatasetVersion}`);
  console.log(`Versões de seed       : ${[...seedVersions].join(", ") || "(nenhuma)"}`);
  console.log(`Itens sintéticos a apagar: ${toDelete.length} (de ${current.length})`);
  if (!apply) {
    console.log("Ensaio: nada foi escrito. Use --apply para executar.");
    return;
  }

  await client.send(new PutCommand({ TableName: table, Item: originalActive }));
  console.log("Manifesto original restaurado.");
  for (let i = 0; i < toDelete.length; i += 25) {
    let pending = {
      [table]: toDelete
        .slice(i, i + 25)
        .map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
    };
    for (let attempt = 0; attempt < 8 && pending[table]?.length; attempt += 1) {
      const response = await client.send(
        new BatchWriteCommand({ RequestItems: pending }),
      );
      pending = response.UnprocessedItems || {};
      if (pending[table]?.length)
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
    if (pending[table]?.length)
      throw new Error("Itens não processados após 8 tentativas.");
  }
  console.log(`Apagados ${toDelete.length} itens sintéticos.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

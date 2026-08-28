/**
 * Esvazia monitoracao-operacional (nunca os 3 casos curados da golden set —
 * ela é curada manualmente e não deve ser apagada por um script de dev).
 *
 * A exceção é o único caso que a própria suíte de testes cria em tempo de
 * execução (ver TEST_PROMOTED_CASES): a coleção Postman confirma uma
 * hipótese pra provar a promoção à golden set (ADR-005), e isso persiste
 * de uma rodada pra outra se não for limpo — sem isso, a segunda execução
 * da coleção encontra golden set onde a primeira esperava 404.
 *
 * Uso: node scripts/reset.js  (ou `npm run reset`)
 * Rodar antes de `npm run seed` para garantir contagens previsíveis nos
 * testes (ver artefatos/postman/monitoracao-api.postman_collection.json).
 */
require("dotenv").config({ quiet: true });
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-1";
const OPERATIONAL_TABLE = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";
const GOLDEN_SET_TABLE = process.env.GOLDEN_SET_TABLE_NAME || "monitoracao-golden-set";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/** Só entram aqui casos que a suíte de testes promove sozinha — nunca um dos 3 curados manualmente pelo seed. */
const TEST_PROMOTED_CASES = ["Identidade#Mobile#Nacional"];

async function resetOperationalTable() {
  const scan = await client.send(
    new ScanCommand({ TableName: OPERATIONAL_TABLE, ProjectionExpression: "pk, sk" }),
  );
  for (const item of scan.Items) {
    await client.send(new DeleteCommand({ TableName: OPERATIONAL_TABLE, Key: { pk: item.pk, sk: item.sk } }));
  }
  console.log(`Removidos ${scan.Items.length} itens de ${OPERATIONAL_TABLE}`);
}

async function resetTestPromotedGoldenSetCases() {
  for (const caseId of TEST_PROMOTED_CASES) {
    await client.send(new DeleteCommand({ TableName: GOLDEN_SET_TABLE, Key: { case_id: caseId } }));
  }
  console.log(`Removido(s) ${TEST_PROMOTED_CASES.length} caso(s) de teste de ${GOLDEN_SET_TABLE}`);
}

async function main() {
  await resetOperationalTable();
  await resetTestPromotedGoldenSetCases();
}

main().catch((error) => {
  console.error("Falha ao resetar a tabela operacional:", error);
  process.exit(1);
});

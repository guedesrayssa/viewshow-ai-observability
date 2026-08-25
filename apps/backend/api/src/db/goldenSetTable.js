/**
 * Única porta de baixo nível para monitoracao-golden-set — só leitura.
 *
 * Proteção do ADR-002 aplicada aqui: este módulo, de propósito, NÃO exporta
 * put/update. A conta de laboratório AWS não permite IAM separado por role
 * (ver docs/decisoes.md), então a barreira contra o job de ingestão ou
 * qualquer outro código escrever na golden set é este arquivo não oferecer
 * a operação — não adicionar PutCommand/UpdateCommand aqui.
 */
const { QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { documentClient } = require("./client");

const TABLE_NAME = process.env.GOLDEN_SET_TABLE_NAME || "monitoracao-golden-set";

async function get(key) {
  const result = await documentClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  return result.Item || null;
}

async function query(params) {
  const result = await documentClient.send(new QueryCommand({ TableName: TABLE_NAME, ...params }));
  return result.Items || [];
}

module.exports = { TABLE_NAME, get, query };

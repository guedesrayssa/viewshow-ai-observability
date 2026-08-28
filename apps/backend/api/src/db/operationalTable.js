/**
 * Única porta de baixo nível para monitoracao-operacional (incidentes,
 * evidências, hipóteses). Quem usa isso diretamente é evidenceService.js —
 * ver ADR-004 (serviço de evidências como única porta pra tabela operacional).
 */
const { QueryCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { documentClient } = require("./client");

const TABLE_NAME = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";

async function query(params) {
  const result = await documentClient.send(new QueryCommand({ TableName: TABLE_NAME, ...params }));
  return result.Items || [];
}

async function put(item) {
  await documentClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function update(params) {
  const result = await documentClient.send(new UpdateCommand({ TableName: TABLE_NAME, ...params }));
  return result.Attributes;
}

module.exports = { TABLE_NAME, query, put, update };

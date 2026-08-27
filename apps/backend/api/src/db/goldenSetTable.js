/**
 * Única porta de baixo nível para monitoracao-golden-set — leitura livre,
 * escrita restrita a um único caso de uso.
 *
 * Proteção do ADR-002: a conta de laboratório AWS não permite IAM separado
 * por role (ver docs/decisoes.md), então a barreira contra o job de
 * ingestão (ou qualquer código automático) escrever aqui é este arquivo só
 * expor `putCurated`, não um `put` genérico — e só goldenSetService.js usa
 * isso, só a partir da rota de revisão humana de hipótese
 * (PATCH /incidents/:id/hypothesis/review, atrás de requireAuth). O job de
 * ingestão roda num deploy separado e nunca importa este módulo.
 */
const { QueryCommand, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
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

/** Único ponto de escrita — curadoria humana, nunca o job/agente. */
async function putCurated(item) {
  await documentClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

module.exports = { TABLE_NAME, get, query, putCurated };

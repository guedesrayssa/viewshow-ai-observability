/**
 * Contas registradas pela tela de criar conta.
 *
 * A senha nunca é guardada: fica o hash scrypt com sal por usuário, comparado
 * em tempo constante no login. O usuário vive na tabela operacional, na
 * família `USER#<email>` — a mesma single-table dos incidentes, sem tabela
 * nova para provisionar.
 *
 * Sem DynamoDB alcançável (ambiente local sem credenciais AWS), o serviço cai
 * para um registro em memória do processo e avisa no log: o fluxo de criar
 * conta e entrar continua funcional para desenvolvimento, e os usuários somem
 * quando o processo reinicia — comportamento declarado, não silencioso.
 */
const crypto = require("crypto");
const { documentClient } = require("../db/client");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE_NAME = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";

const SCRYPT_KEYLEN = 64;

/** Registro em memória usado quando o DynamoDB não responde. */
const memoryUsers = new Map();
let warnedMemoryFallback = false;

function warnMemory(error) {
  if (warnedMemoryFallback) return;
  warnedMemoryFallback = true;
  console.warn(
    "DynamoDB indisponível para contas; usando registro em memória:",
    error.message,
  );
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuf = Buffer.from(expected, "hex");
  return (
    actual.length === expectedBuf.length && crypto.timingSafeEqual(actual, expectedBuf)
  );
}

function userKey(email) {
  return { pk: `USER#${email}`, sk: "PROFILE" };
}

async function findUser(email) {
  const normalized = normalizeEmail(email);

  try {
    const result = await documentClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: userKey(normalized) }),
    );
    if (result.Item) return result.Item;
  } catch (error) {
    warnMemory(error);
    return memoryUsers.get(normalized) || null;
  }

  // O Dynamo respondeu mas não achou; a memória cobre contas criadas durante
  // uma queda anterior do banco no mesmo processo.
  return memoryUsers.get(normalized) || null;
}

/**
 * Cria uma conta nova.
 *
 * @returns O perfil criado, ou `null` quando o e-mail já está registrado.
 */
async function createUser({ name, email, password }) {
  const normalized = normalizeEmail(email);

  if (await findUser(normalized)) return null;

  const item = {
    ...userKey(normalized),
    email: normalized,
    name: String(name || "").trim(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };

  try {
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        // Corrida entre dois cadastros do mesmo e-mail: o segundo falha em vez
        // de sobrescrever o primeiro.
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return null;
    warnMemory(error);
    memoryUsers.set(normalized, item);
  }

  return { email: item.email, name: item.name };
}

/**
 * Confere e-mail e senha de uma conta registrada.
 *
 * @returns O perfil, ou `null` quando a conta não existe ou a senha não bate.
 */
async function authenticate(email, password) {
  const user = await findUser(email);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return { email: user.email, name: user.name };
}

module.exports = { createUser, authenticate, normalizeEmail };

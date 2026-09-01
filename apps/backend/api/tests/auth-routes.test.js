/**
 * Fronteira de autenticação das rotas que ESCREVEM.
 * Não toca o DynamoDB: o requireAuth rejeita antes do handler, então este
 * teste roda offline, sem credencial da AWS e sem tabela provisionada.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("../src/app");

/** Sobe o app numa porta efêmera e devolve a base da URL. */
async function startApp(t) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

const PROTEGIDAS = [
  { nome: "POST /incidents/:id/diagnose", method: "POST", path: "/api/v1/incidents/inc-000001/diagnose" },
  {
    nome: "PATCH /incidents/:id/hypothesis/review",
    method: "PATCH",
    path: "/api/v1/incidents/inc-000001/hypothesis/review",
    body: { status: "confirmed" },
  },
];

for (const rota of PROTEGIDAS) {
  test(`${rota.nome} responde 401 sem cookie de sessão`, async (t) => {
    const base = await startApp(t);

    const response = await fetch(`${base}${rota.path}`, {
      method: rota.method,
      headers: { "Content-Type": "application/json" },
      body: rota.body ? JSON.stringify(rota.body) : undefined,
    });

    assert.equal(response.status, 401);
    const corpo = await response.json();
    assert.equal(corpo.error.message, "Sessão inválida ou ausente");
    // Barrou antes do orquestrador: nada de diagnóstico no corpo.
    assert.equal(corpo.hypothesis, undefined);
  });

  test(`${rota.nome} responde 401 com cookie de sessão forjado`, async (t) => {
    const base = await startApp(t);

    const response = await fetch(`${base}${rota.path}`, {
      method: rota.method,
      headers: {
        "Content-Type": "application/json",
        // Assinatura HMAC inválida: o verifySession precisa rejeitar.
        Cookie: "session=demo%40globoplay.com.assinatura-invalida",
      },
      body: rota.body ? JSON.stringify(rota.body) : undefined,
    });

    assert.equal(response.status, 401);
  });
}

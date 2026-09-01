const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const evidenceService = require("../src/services/evidenceService");
const app = require("../src/app");

/**
 * O resumo é derivado de evidenceService.listIncidents. O teste troca essa
 * leitura por uma lista fixa para exercitar só o contrato da rota, sem depender
 * de um DynamoDB alcançável no ambiente de CI.
 */
test("GET /api/v1/dashboard/summary devolve stats numéricos e incidentes recentes", async (t) => {
  const original = evidenceService.listIncidents;
  evidenceService.listIncidents = async () => [
    { id: "a", title: "A", status: "critical", statusLabel: "Crítico", devices: 1200, startedMinutesAgo: 5 },
    { id: "b", title: "B", status: "warning", statusLabel: "Atenção", devices: 300, startedMinutesAgo: 20 },
    { id: "c", title: "C", status: "success", statusLabel: "Estável", devices: 0, startedMinutesAgo: 40 },
  ];
  t.after(() => {
    evidenceService.listIncidents = original;
  });

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

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/summary`);

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.stats.length, 3);
  for (const stat of body.stats) {
    assert.equal(typeof stat.value, "number", `${stat.id} deve ter value numérico`);
    assert.ok(["compact", "integer"].includes(stat.format), `${stat.id} format inválido`);
    assert.ok(["info", "warning", "critical"].includes(stat.accent), `${stat.id} accent inválido`);
  }

  const byId = Object.fromEntries(body.stats.map((stat) => [stat.id, stat.value]));
  assert.equal(byId["affected-sessions"], 1500);
  assert.equal(byId["active-incidents"], 2);
  assert.equal(byId["critical-incidents"], 1);

  assert.equal(body.recentIncidents.length, 3);
  assert.equal(body.recentIncidents[0].id, "a");
});

const test = require("node:test");
const assert = require("node:assert/strict");

const operationalTable = require("../src/db/operationalTable");
const evidenceService = require("../src/services/evidenceService");

test("serviço lê bundles v1/v2 sem tratar filhos legados como incidentes", async (t) => {
  const originalQuery = operationalTable.query;
  t.after(() => {
    operationalTable.query = originalQuery;
  });

  const incident = {
    pk: "INC#2026-09-06T20",
    sk: "INCIDENT#inc-1",
    trace_id: "inc-1",
    id: "inc-1",
    startedMinutesAgo: 1,
  };
  const legacyEvidence = {
    pk: incident.pk,
    sk: "INCIDENT#inc-1#EVIDENCE#001",
    trace_id: "inc-1",
  };
  const legacyHypothesis = {
    pk: incident.pk,
    sk: "INCIDENT#inc-1#HYPOTHESIS#0000000001",
    trace_id: "inc-1",
  };
  const currentHypothesis = {
    pk: incident.pk,
    sk: "HYPOTHESIS#inc-1#0000000042",
    trace_id: "inc-1",
  };
  const items = [legacyEvidence, legacyHypothesis, incident, currentHypothesis];

  operationalTable.query = async () => items;

  const listed = await evidenceService.listIncidents({ window: "15m" });
  assert.ok(listed.length > 0);
  assert.ok(listed.every((item) => item === incident));

  const bundle = await evidenceService.getIncidentBundle("inc-1");
  assert.equal(bundle.incident, incident);
  assert.deepEqual(bundle.evidence, [legacyEvidence]);
  assert.deepEqual(bundle.hypotheses, [legacyHypothesis, currentHypothesis]);

  const latest = await evidenceService.getLatestHypothesis("inc-1");
  assert.equal(latest, currentHypothesis);
});

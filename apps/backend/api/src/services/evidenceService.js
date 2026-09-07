/**
 * Única porta para incidentes/evidências/hipóteses na tabela operacional
 * (ADR-004). O orquestrador e o agente nunca chamam operationalTable.js
 * direto — sempre passam por aqui.
 */
const operationalTable = require("../db/operationalTable");
const { hourBucket, incidentSk, hypothesisSk, itemTypeFromSk } = require("../db/keys");

const WINDOW_ALIASES = {
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "24h": 1440,
};

function parseWindowMinutes(window) {
  if (!window) return 360; // default: 6h
  if (WINDOW_ALIASES[window]) return WINDOW_ALIASES[window];
  const asNumber = Number(window);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : 360;
}

/** Buckets de hora que cobrem [agora - windowMinutes, agora], sem Scan. */
function bucketsForWindow(windowMinutes) {
  const hours = Math.max(1, Math.ceil(windowMinutes / 60) + 1);
  const buckets = [];
  const now = new Date();
  for (let i = 0; i < hours; i += 1) {
    buckets.push(hourBucket(new Date(now.getTime() - i * 60 * 60 * 1000)));
  }
  return buckets;
}

function matchesFilters(incident, filters) {
  if (filters.deviceType && incident.deviceType !== filters.deviceType) return false;
  if (filters.region && incident.region !== filters.region) return false;
  if (filters.appVersion && incident.appVersion !== filters.appVersion) return false;
  return true;
}

async function listIncidents(filters = {}) {
  const windowMinutes = parseWindowMinutes(filters.window);
  const buckets = bucketsForWindow(windowMinutes);

  const results = await Promise.all(
    buckets.map((pk) =>
      operationalTable.query({
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "INCIDENT#" },
      }),
    ),
  );

  const incidents = results
    .flat()
    .filter((item) => itemTypeFromSk(item.sk) === "INCIDENT")
    .filter((incident) => matchesFilters(incident, filters));

  incidents.sort((a, b) => a.startedMinutesAgo - b.startedMinutesAgo);
  return incidents;
}

/**
 * Um único Query no GSI trace-index traz incidente, evidências e hipótese
 * juntos — todos os itens de um incidente compartilham trace_id.
 */
async function getIncidentBundle(incidentId) {
  const items = await operationalTable.query({
    IndexName: "trace-index",
    KeyConditionExpression: "trace_id = :id",
    ExpressionAttributeValues: { ":id": incidentId },
  });

  const bundle = { incident: null, evidence: [], hypotheses: [] };
  for (const item of items) {
    const type = itemTypeFromSk(item.sk);
    if (type === "INCIDENT") bundle.incident = item;
    else if (type === "EVIDENCE") bundle.evidence.push(item);
    else if (type === "HYPOTHESIS") bundle.hypotheses.push(item);
  }
  return bundle;
}

async function getIncidentById(incidentId) {
  const bundle = await getIncidentBundle(incidentId);
  return bundle.incident;
}

async function getEvidenceByIncidentId(incidentId) {
  const bundle = await getIncidentBundle(incidentId);
  return bundle.evidence;
}

async function saveHypothesis(incidentId, hypothesis) {
  const incident = await getIncidentById(incidentId);
  if (!incident) throw new Error(`Incidente não encontrado: ${incidentId}`);

  const item = {
    pk: incident.pk,
    sk: hypothesisSk(incidentId, Math.floor(Date.now() / 1000)),
    trace_id: incidentId,
    ttl: incident.ttl,
    incidentId,
    ...hypothesis,
    createdAt: new Date().toISOString(),
  };
  return operationalTable.put(item);
}

/** sk da hipótese tem epoch com largura fixa, então ordem lexicográfica == cronológica. */
async function getLatestHypothesis(incidentId) {
  const bundle = await getIncidentBundle(incidentId);
  if (!bundle.hypotheses.length) return null;
  // Compara apenas o último segmento para que v1
  // (INCIDENT#id#HYPOTHESIS#epoch) e v2 (HYPOTHESIS#id#epoch) possam
  // coexistir sem o prefixo do schema decidir incorretamente qual é a última.
  return bundle.hypotheses.reduce((latest, item) => {
    const latestSequence = latest.sk.split("#").at(-1);
    const itemSequence = item.sk.split("#").at(-1);
    return itemSequence > latestSequence ? item : latest;
  });
}

/** Marca a hipótese mais recente como confirmada/refutada por um humano (US-ENG-01). */
async function reviewHypothesis(incidentId, { status, reviewedBy }) {
  const hypothesis = await getLatestHypothesis(incidentId);
  if (!hypothesis) return null;

  return operationalTable.update({
    Key: { pk: hypothesis.pk, sk: hypothesis.sk },
    UpdateExpression: "SET reviewStatus = :status, reviewedBy = :reviewedBy, reviewedAt = :reviewedAt",
    ExpressionAttributeValues: {
      ":status": status,
      ":reviewedBy": reviewedBy,
      ":reviewedAt": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  });
}

module.exports = {
  listIncidents,
  getIncidentById,
  getEvidenceByIncidentId,
  getIncidentBundle,
  saveHypothesis,
  getLatestHypothesis,
  reviewHypothesis,
  incidentSk,
};

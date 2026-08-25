/**
 * Popula monitoracao-operacional e monitoracao-golden-set com dados de teste,
 * já que a Fase 1 (BigQuery -> DynamoDB) não roda neste ambiente.
 *
 * Convenção de chaves (docs/decisoes.md):
 *   operacional: pk = "INC#<hora-UTC-ISO>", sk = "INCIDENT#<id>" |
 *     "INCIDENT#<id>#EVIDENCE#<seq:3>" | "INCIDENT#<id>#HYPOTHESIS#<epoch:10>",
 *     trace_id = <incident_id> em todo item, ttl = epoch seconds.
 *   golden-set: case_id = assinatura determinística "<component>#<deviceType>#<region>"
 *     (permite GetItem direto por assinatura, sem Scan e sem GSI extra).
 *
 * Uso: node scripts/seed.js
 */

require("dotenv").config({ quiet: true });
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { hourBucket, incidentSk, evidenceSk, hypothesisSk } = require("../src/db/keys");

const REGION = process.env.AWS_REGION || "us-east-1";
const OPERATIONAL_TABLE = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";
const GOLDEN_SET_TABLE = process.env.GOLDEN_SET_TABLE_NAME || "monitoracao-golden-set";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const TTL_SECONDS_FROM_NOW = 30 * 24 * 60 * 60; // 30 dias
const nowEpoch = () => Math.floor(Date.now() / 1000);
const ttl = () => nowEpoch() + TTL_SECONDS_FROM_NOW;

/** Mesmos 4 casos de exemplo usados em incidents-view.tsx, para o frontend
 * mostrar dado plausível assim que a rota real for plugada. */
const INCIDENTS = [
  {
    id: "falhas-reproducao-tvs-lg",
    urgency: "P1",
    title: "Falhas de reprodução em TVs LG",
    segment: "12,4 mil sessões · Nordeste · webOS 6.0",
    devices: 8420,
    startedAt: "09:18",
    startedMinutesAgo: 12,
    component: "Player",
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
    sessions: "12,4 mil sessões",
    timeAgo: "há 18 min",
    status: "critical",
    statusLabel: "Crítico",
    evidence: [
      { type: "log", description: "Erro MEDIA_ERR_DECODE em 68% das sessões webOS 6.0", source: "Player" },
      { type: "metric", description: "Taxa de erro de reprodução subiu de 2% para 41% em 12 min", source: "Youbora" },
    ],
    hypothesis: {
      text: "Regressão no decoder de vídeo da versão 4.2.1 para webOS 6.0",
      score: 0.82,
    },
  },
  {
    id: "timeout-cdn-nordeste",
    urgency: "P2",
    title: "Timeout de CDN no Nordeste",
    segment: "3,2 mil sessões · POP Recife · Fastly",
    devices: 2150,
    startedAt: "08:52",
    startedMinutesAgo: 38,
    component: "CDN",
    deviceType: "Multiplataforma",
    region: "Nordeste",
    appVersion: "App 4.1.8",
    sessions: "2,1 mil sessões",
    timeAgo: "há 31 min",
    status: "warning",
    statusLabel: "Atenção",
    evidence: [
      { type: "metric", description: "Latência p95 do POP Recife subiu de 80ms para 1.4s", source: "Fastly" },
    ],
    hypothesis: null,
  },
  {
    id: "licencas-drm-tvs-samsung",
    urgency: "P3",
    title: "Licenças DRM expiradas em TVs Samsung",
    segment: "1,1 mil sessões · Tizen 7 · conteúdo VOD",
    devices: 824,
    startedAt: "08:36",
    startedMinutesAgo: 54,
    component: "DRM",
    deviceType: "Smart TV",
    region: "Sul",
    appVersion: "App 4.2.1",
    sessions: "824 sessões",
    timeAgo: "há 42 min",
    status: "info",
    statusLabel: "Ativo",
    evidence: [
      { type: "log", description: "Renovação de licença Widevine falhando com HTTP 403", source: "DRM" },
    ],
    hypothesis: {
      text: "Certificado de licenciamento Widevine expirado para Tizen 7",
      score: 0.74,
    },
  },
  {
    id: "tokens-autenticacao-invalidos",
    urgency: "P4",
    title: "Tokens de autenticação inválidos",
    segment: "430 sessões · múltiplas plataformas",
    devices: 390,
    startedAt: "07:58",
    startedMinutesAgo: 92,
    component: "Identidade",
    deviceType: "Mobile",
    region: "Nacional",
    appVersion: "App 4.0.5",
    sessions: "430 sessões",
    timeAgo: "há 1 h",
    status: "success",
    statusLabel: "Estável",
    evidence: [
      { type: "log", description: "Pico isolado de HTTP 401 em app 4.0.5, sem recorrência", source: "Identidade" },
    ],
    hypothesis: null,
  },
];

/** Casos curados manualmente — alimentam o orquestrador com diagnóstico já
 * conhecido para assinaturas repetidas (component#deviceType#region). */
const GOLDEN_SET = [
  {
    signature: "Player#Smart TV#Nordeste",
    expected_hypothesis: "Regressão no decoder de vídeo para o modelo/firmware afetado",
    expected_score: 0.85,
    curated_by: "time-observabilidade",
  },
  {
    signature: "DRM#Smart TV#Sul",
    expected_hypothesis: "Certificado de licenciamento expirado para a plataforma afetada",
    expected_score: 0.78,
    curated_by: "time-observabilidade",
  },
  {
    signature: "CDN#Multiplataforma#Nordeste",
    expected_hypothesis: "Degradação de um POP regional específico da CDN",
    expected_score: 0.7,
    curated_by: "time-observabilidade",
  },
];

async function seedIncident(incident) {
  const bucket = hourBucket(new Date(Date.now() - incident.startedMinutesAgo * 60 * 1000));

  const incidentItem = {
    pk: bucket,
    sk: incidentSk(incident.id),
    trace_id: incident.id,
    ttl: ttl(),
    id: incident.id,
    urgency: incident.urgency,
    title: incident.title,
    segment: incident.segment,
    devices: incident.devices,
    startedAt: incident.startedAt,
    startedMinutesAgo: incident.startedMinutesAgo,
    component: incident.component,
    deviceType: incident.deviceType,
    region: incident.region,
    appVersion: incident.appVersion,
    sessions: incident.sessions,
    timeAgo: incident.timeAgo,
    status: incident.status,
    statusLabel: incident.statusLabel,
  };

  await client.send(new PutCommand({ TableName: OPERATIONAL_TABLE, Item: incidentItem }));
  console.log(`  incidente: ${incident.id}`);

  for (const [index, evidence] of incident.evidence.entries()) {
    const evidenceItem = {
      pk: bucket,
      sk: evidenceSk(incident.id, index + 1),
      trace_id: incident.id,
      ttl: ttl(),
      incidentId: incident.id,
      type: evidence.type,
      description: evidence.description,
      source: evidence.source,
      capturedAt: new Date().toISOString(),
    };
    await client.send(new PutCommand({ TableName: OPERATIONAL_TABLE, Item: evidenceItem }));
    console.log(`    evidência ${index + 1}: ${evidence.description}`);
  }

  if (incident.hypothesis) {
    const hypothesisItem = {
      pk: bucket,
      sk: hypothesisSk(incident.id, 1),
      trace_id: incident.id,
      ttl: ttl(),
      incidentId: incident.id,
      text: incident.hypothesis.text,
      score: incident.hypothesis.score,
      source: "seed",
      createdAt: new Date().toISOString(),
    };
    await client.send(new PutCommand({ TableName: OPERATIONAL_TABLE, Item: hypothesisItem }));
    console.log(`    hipótese: ${incident.hypothesis.text} (score ${incident.hypothesis.score})`);
  }
}

async function seedGoldenSetCase(item) {
  await client.send(
    new PutCommand({
      TableName: GOLDEN_SET_TABLE,
      Item: {
        case_id: item.signature,
        incident_signature: item.signature,
        expected_hypothesis: item.expected_hypothesis,
        expected_score: item.expected_score,
        curated_by: item.curated_by,
        curated_at: new Date().toISOString(),
      },
    }),
  );
  console.log(`  caso golden set: ${item.signature}`);
}

async function main() {
  console.log(`Semeando ${OPERATIONAL_TABLE} (região ${REGION})...`);
  for (const incident of INCIDENTS) {
    await seedIncident(incident);
  }

  console.log(`\nSemeando ${GOLDEN_SET_TABLE}...`);
  for (const item of GOLDEN_SET) {
    await seedGoldenSetCase(item);
  }

  console.log("\nConcluído.");
}

main().catch((error) => {
  console.error("Falha ao semear dados de teste:", error);
  process.exit(1);
});

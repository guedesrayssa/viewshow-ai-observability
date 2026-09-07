/**
 * Seed de CARGA para monitoracao-operacional e monitoracao-golden-set.
 *
 * Diferente de scripts/seed.js (4 incidentes fixos, para o frontend ter dado
 * plausível), este existe para que o teste de desempenho meça algo real:
 *
 *   - volume suficiente para a resposta de /incidents ter tamanho de produção;
 *   - incidentes distribuídos por TODOS os buckets de hora que a consulta
 *     varre, para que window=15m, 1h, 6h e 24h exerçam caminhos diferentes;
 *   - IDs ordinais e determinísticos (inc-000001 …), para o k6 sortear alvos
 *     sem precisar ler um manifesto;
 *   - assinaturas que batem na golden set em ~60% dos casos, para /diagnose
 *     exercitar tanto o atalho determinístico quanto o fallback do agente.
 *
 * Fonte canônica: artefatos/sprint2/testes-carga/seed-carga.js. Mantenha a
 * cópia em apps/backend/api/scripts/ sincronizada.
 * USO: node scripts/seed-carga.js (a partir de apps/backend/api)
 *
 * Variáveis:
 *   INCIDENTS_PER_HOUR  padrão 12
 *   HOURS_BACK          padrão 25   (cobre window=24h, que varre 25 buckets)
 *   EVIDENCE_MIN/MAX    padrão 4/8
 */

require("dotenv").config({ quiet: true });
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

// Fonte única da convenção de chaves — nunca reimplementar aqui.
let keys;
for (const candidate of ["../src/db/keys", "./src/db/keys", "../api/src/db/keys"]) {
  try {
    keys = require(candidate);
    break;
  } catch (_) { /* tenta o próximo */ }
}
if (!keys) {
  console.error(
    "Não encontrei src/db/keys.js.\n" +
    "Coloque este arquivo em apps/backend/api/scripts/ e rode de apps/backend/api.",
  );
  process.exit(1);
}
const { hourBucket, incidentSk } = keys;

/**
 * KEY_SCHEME controla o prefixo dos itens filhos — é o que o teste de carga
 * mediu como causa raiz (testes-desempenho.md, §8).
 *
 *   v2 (padrão — CORRIGIDO, é o que src/db/keys.js gera hoje em produção):
 *       EVIDENCE#<id>#001 / HYPOTHESIS#<id>#0000000001. Chama keys.js direto,
 *       então nunca diverge do que a API realmente grava.
 *
 *   v1 (legado — só para reproduzir o baseline ANTIGO numa rodada dedicada de
 *       comparação "antes/depois"): INCIDENT#<id>#EVIDENCE#001. Todos os sk
 *       compartilhavam o prefixo "INCIDENT#", e a Query de listIncidents
 *       trazia evidências e hipóteses junto, descartando ~87% em memória.
 *       A API continua lendo v1 corretamente durante a transição, mas a
 *       listagem ainda paga o custo de ler e filtrar os filhos legados.
 *       Use este modo apenas para comparar RCU e latência com o baseline.
 */
const KEY_SCHEME = process.env.KEY_SCHEME || "v2";

const evidenceSk = (id, seq) =>
  KEY_SCHEME === "v1"
    ? `INCIDENT#${id}#EVIDENCE#${String(seq).padStart(3, "0")}`
    : keys.evidenceSk(id, seq);

const hypothesisSk = (id, seq) =>
  KEY_SCHEME === "v1"
    ? `INCIDENT#${id}#HYPOTHESIS#${String(seq).padStart(10, "0")}`
    : keys.hypothesisSk(id, seq);

const REGION = process.env.AWS_REGION || "us-east-1";
const OPERATIONAL_TABLE = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";
const GOLDEN_SET_TABLE = process.env.GOLDEN_SET_TABLE_NAME || "monitoracao-golden-set";

const INCIDENTS_PER_HOUR = Number(process.env.INCIDENTS_PER_HOUR || 12);
const HOURS_BACK = Number(process.env.HOURS_BACK || 25);
const EVIDENCE_MIN = Number(process.env.EVIDENCE_MIN || 4);
const EVIDENCE_MAX = Number(process.env.EVIDENCE_MAX || 8);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const TTL_SECONDS_FROM_NOW = 30 * 24 * 60 * 60;
const ttl = () => Math.floor(Date.now() / 1000) + TTL_SECONDS_FROM_NOW;

/* ---------- dimensões, tiradas do vocabulário real do DATASET.md ---------- */

const COMPONENTES = ["Player", "CDN", "DRM", "Identidade", "API GraphQL", "Origem", "Borda", "Redis"];
const DEVICE_TYPES = ["Smart TV", "Mobile", "Web", "Multiplataforma"];
const REGIOES = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul", "Nacional"];
const APP_VERSIONS = ["App 4.0.5", "App 4.1.8", "App 4.2.1", "App 4.3.0"];
const URGENCIAS = ["P1", "P2", "P3", "P4"];
const STATUS = [
  { status: "critical", statusLabel: "Crítico" },
  { status: "warning", statusLabel: "Atenção" },
  { status: "info", statusLabel: "Ativo" },
  { status: "success", statusLabel: "Estável" },
];
const FONTES = ["Player", "Youbora", "Fastly", "Prometheus", "New Relic", "Apollo", "RPaaS", "Cloud Armor"];
const FORCAS = ["forte", "média", "neutra", "contrária"];

/** PRNG com semente fixa: duas execuções produzem a mesma base, o que torna
 *  duas rodadas de teste comparáveis entre si. */
let semente = 20260827;
function rand() {
  semente = (semente * 1103515245 + 12345) & 0x7fffffff;
  return semente / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const intBetween = (min, max) => min + Math.floor(rand() * (max - min + 1));

/* ---------- geração ---------- */

function buildIncident(ordinal, minutesAgo) {
  const componente = pick(COMPONENTES);
  const deviceType = pick(DEVICE_TYPES);
  const region = pick(REGIOES);
  const st = pick(STATUS);
  const devices = intBetween(120, 42000);
  const startedAt = new Date(Date.now() - minutesAgo * 60 * 1000);

  return {
    id: `inc-${String(ordinal).padStart(6, "0")}`,
    minutesAgo,
    urgency: pick(URGENCIAS),
    title: `Degradação em ${componente} · ${deviceType}`,
    segment: `${devices.toLocaleString("pt-BR")} sessões · ${region} · ${deviceType}`,
    devices,
    startedAt: startedAt.toISOString().slice(11, 16),
    startedMinutesAgo: minutesAgo,
    component: componente,
    deviceType,
    region,
    appVersion: pick(APP_VERSIONS),
    sessions: `${devices.toLocaleString("pt-BR")} sessões`,
    timeAgo: minutesAgo < 60 ? `há ${minutesAgo} min` : `há ${Math.floor(minutesAgo / 60)} h`,
    status: st.status,
    statusLabel: st.statusLabel,
  };
}

function buildItems(incident) {
  const bucket = hourBucket(new Date(Date.now() - incident.minutesAgo * 60 * 1000));
  const base = { pk: bucket, trace_id: incident.id, ttl: ttl() };
  const items = [];

  const { minutesAgo, ...incidentFields } = incident;
  items.push({ ...base, sk: incidentSk(incident.id), ...incidentFields });

  const qtdEvidencias = intBetween(EVIDENCE_MIN, EVIDENCE_MAX);
  for (let i = 1; i <= qtdEvidencias; i += 1) {
    items.push({
      ...base,
      sk: evidenceSk(incident.id, i),
      incidentId: incident.id,
      type: rand() > 0.5 ? "metric" : "log",
      description:
        `${pick(FONTES)}: ${incident.component} com desvio de ` +
        `${intBetween(120, 900)}% sobre a baseline de 14 dias em ${incident.region}`,
      source: pick(FONTES),
      strength: pick(FORCAS),
      capturedAt: new Date().toISOString(),
    });
  }

  // ~70% dos incidentes já têm hipótese registrada.
  if (rand() < 0.7) {
    items.push({
      ...base,
      sk: hypothesisSk(incident.id, 1),
      incidentId: incident.id,
      text: `Causa provável em ${incident.component} afetando ${incident.deviceType} na região ${incident.region}`,
      score: Number((0.55 + rand() * 0.4).toFixed(2)),
      source: "seed-carga",
      createdAt: new Date().toISOString(),
    });
  }

  return items;
}

/** Assinaturas que cobrem ~60% das combinações geradas, para que /diagnose
 *  passe pelo atalho da golden set na maioria das vezes e caia no agente no
 *  restante — os dois caminhos entram no teste. */
function buildGoldenSet() {
  const casos = [];
  for (const componente of COMPONENTES) {
    for (const deviceType of DEVICE_TYPES) {
      for (const region of REGIOES) {
        if (rand() > 0.6) continue;
        casos.push({
          case_id: `${componente}#${deviceType}#${region}`,
          incident_signature: `${componente}#${deviceType}#${region}`,
          expected_hypothesis: `Padrão conhecido: ${componente} degradado para ${deviceType} em ${region}`,
          expected_score: Number((0.6 + rand() * 0.35).toFixed(2)),
          curated_by: "seed-carga",
          curated_at: new Date().toISOString(),
        });
      }
    }
  }
  return casos;
}

/* ---------- limpeza ---------- */

const MAX_BATCH_ATTEMPTS = 8;

function esperarBackoff(tentativa) {
  const exponencial = Math.min(100 * 2 ** tentativa, 5000);
  const jitter = Math.floor(Math.random() * 100);
  return new Promise((resolve) => setTimeout(resolve, exponencial + jitter));
}

/** Envia até 25 operações, repetindo somente UnprocessedItems. */
async function enviarLoteComRetry(
  tableName,
  requests,
  { documentClient = client, wait = esperarBackoff, maxAttempts = MAX_BATCH_ATTEMPTS } = {},
) {
  let pendentes = { [tableName]: requests };

  for (let tentativa = 0; tentativa < maxAttempts; tentativa += 1) {
    const resposta = await documentClient.send(new BatchWriteCommand({ RequestItems: pendentes }));
    const restantes = resposta.UnprocessedItems?.[tableName] || [];
    if (restantes.length === 0) return;

    if (tentativa === maxAttempts - 1) {
      throw new Error(
        `${restantes.length} operações em ${tableName} continuaram não processadas ` +
        `após ${maxAttempts} tentativas`,
      );
    }

    pendentes = { [tableName]: restantes };
    await wait(tentativa);
  }
}

/** Remove apenas dados de incidentes da tabela operacional. Contas USER# e
 *  outros domínios compartilhados são preservados. A limpeza é necessária
 *  para o benchmark não misturar os schemas v1 e v2. */
async function limparTabela(
  tableName,
  { documentClient = client, wait = esperarBackoff, maxAttempts = MAX_BATCH_ATTEMPTS } = {},
) {
  let chaveInicial;
  let removidos = 0;

  do {
    const pagina = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: chaveInicial,
      }),
    );

    const itens = (pagina.Items || []).filter(
      ({ pk }) => typeof pk === "string" && pk.startsWith("INC#"),
    );
    for (let i = 0; i < itens.length; i += 25) {
      const lote = itens.slice(i, i + 25);
      const requests = lote.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } }));
      await enviarLoteComRetry(tableName, requests, { documentClient, wait, maxAttempts });
      removidos += lote.length;
    }

    chaveInicial = pagina.LastEvaluatedKey;
  } while (chaveInicial);

  return removidos;
}

/* ---------- escrita em lote ---------- */

async function batchWrite(tableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    const lote = items.slice(i, i + 25);
    await enviarLoteComRetry(
      tableName,
      lote.map((Item) => ({ PutRequest: { Item } })),
    );
  }
}

async function main() {
  const total = INCIDENTS_PER_HOUR * HOURS_BACK;

  if (process.env.CLEAN === "1") {
    console.log(`Limpando ${OPERATIONAL_TABLE}…`);
    const removidos = await limparTabela(OPERATIONAL_TABLE);
    console.log(`  ${removidos} itens removidos.`);
  }

  console.log(
    `Gerando ${total} incidentes (${INCIDENTS_PER_HOUR}/hora × ${HOURS_BACK} h) ` +
    `em ${OPERATIONAL_TABLE} · esquema de chaves ${KEY_SCHEME}…`,
  );

  const itens = [];
  let ordinal = 0;
  for (let hora = 0; hora < HOURS_BACK; hora += 1) {
    for (let n = 0; n < INCIDENTS_PER_HOUR; n += 1) {
      ordinal += 1;
      // espalha dentro da hora para não concentrar tudo no minuto cheio
      const minutesAgo = hora * 60 + intBetween(1, 59);
      itens.push(...buildItems(buildIncident(ordinal, minutesAgo)));
    }
  }

  await batchWrite(OPERATIONAL_TABLE, itens);
  console.log(`  ${itens.length} itens gravados (incidentes + evidências + hipóteses).`);

  const golden = buildGoldenSet();
  await batchWrite(GOLDEN_SET_TABLE, golden);
  console.log(`  ${golden.length} casos na golden set.`);

  console.log("\nPronto. Para o k6:");
  console.log(`  INCIDENT_COUNT=${total}`);
  console.log("\n⚠️  Os buckets são relativos ao INSTANTE do seed.");
  console.log("    Rode o teste logo em seguida: window=15m só encontra dado por ~1 h.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Falha ao semear:", error);
    process.exit(1);
  });
}

module.exports = { enviarLoteComRetry, limparTabela };

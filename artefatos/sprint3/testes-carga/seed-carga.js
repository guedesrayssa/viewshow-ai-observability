/**
 * Seed de CARGA para monitoracao-operacional.
 *
 * Diferente de scripts/seed.js (4 incidentes fixos, para o frontend ter dado
 * plausível), este existe para que o teste de desempenho meça algo real:
 *
 *   - volume suficiente para a resposta de /api/v1/incidents ter tamanho de
 *     produção;
 *   - incidentes distribuídos por TODOS os buckets de hora que a consulta
 *     varre, para que window=15m, 1h e 24h exerçam caminhos diferentes;
 *   - IDs ordinais e determinísticos (inc-000001 …), para o k6 sortear alvos
 *     sem precisar ler um manifesto;
 *   - a maioria dos incidentes já com hipótese registrada, para
 *     /diagnosis exercitar tanto o caminho "pronto" quanto o
 *     "not_started" (ver AGENTIC_RESULT_UNAVAILABLE em incident-use-cases.ts).
 *
 * CORREÇÃO (2026-09): este script dependia de um módulo `src/db/keys.js` que
 * não existe mais desde o refactor que colapsou os microsserviços num
 * monólito modular (apps/backend/api/src/modules/incidents/...) — rodá-lo
 * sem esta correção falha com "Não encontrei src/db/keys.js". As chaves
 * abaixo foram realinhadas lendo diretamente
 * apps/backend/api/src/modules/incidents/adapters/dynamodb-incident-repository.ts
 * (pk = `INC#<hora ISO>`, sk com prefixo próprio por tipo de item) e
 * apps/backend/api/src/modules/incidents/domain/incident.ts (`status()` só
 * aceita critical/warning/success como atalho, ou os cinco status
 * canônicos). O conjunto de referência (golden set) também foi removido
 * daqui: nada no código atual de apps/backend/api o lê mais — era usado pelo
 * orquestrador/agente legado, hoje congelado em apps/backend/agentic
 * (ver README daquela pasta). Mantê-lo só custaria escritas sem uso.
 *
 * Cópia versionada para o relatório de carga:
 * artefatos/sprint3/testes-carga/seed-carga.js. Mantenha as duas em sincronia
 * manual — este arquivo precisa estar em apps/backend/api/scripts/ para ser
 * executado a partir do projeto da API.
 *
 * USO: node scripts/seed-carga.js (a partir de apps/backend/api)
 *
 * Variáveis:
 *   OPERATIONAL_TABLE_NAME  padrão monitoracao-operacional (mesma da API)
 *   INCIDENTS_PER_HOUR      padrão 12
 *   HOURS_BACK              padrão 25   (cobre window=24h, que varre até 25 buckets)
 *   EVIDENCE_MIN/MAX        padrão 4/8
 *   CLEAN=1                 remove itens de incidentes (pk=INC#...) antes de semear
 */

require("dotenv").config({ quiet: true });
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

/* ---------- esquema de chaves (espelha dynamodb-incident-repository.ts) --- */

/** pk usado pela Query por hora em listBetween(): `INC#<hora truncada, ISO até HH>`. */
function hourBucket(date) {
  const truncated = new Date(date);
  truncated.setUTCMinutes(0, 0, 0);
  return `INC#${truncated.toISOString().slice(0, 13)}`;
}

// itemKind() em domain/incident.ts reconhece estes três prefixos de sk. O
// item do incidente em si não pode ter mais nenhum "#" depois do id
// (^INCIDENT#[^#]+$), por isso incidentSk não recebe sequência.
const incidentSk = (id) => `INCIDENT#${id}`;
const evidenceSk = (id, seq) => `EVIDENCE#${id}#${String(seq).padStart(3, "0")}`;
const hypothesisSk = (id, seq) => `HYPOTHESIS#${id}#${String(seq).padStart(10, "0")}`;

const REGION = process.env.AWS_REGION || "us-east-1";
const OPERATIONAL_TABLE = process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";

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
// status() em domain/incident.ts só aceita os cinco status canônicos OU estes
// três atalhos (success→resolved, critical/warning→investigating). "info"
// não é um atalho válido — um incidente com esse status derrubaria a
// listagem inteira com 500 (toIncidentDto lança e ninguém captura antes da
// resposta).
const STATUS = [
  { status: "critical", statusLabel: "Crítico" },
  { status: "warning", statusLabel: "Atenção" },
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

  return {
    id: `inc-${String(ordinal).padStart(6, "0")}`,
    minutesAgo,
    urgency: pick(URGENCIAS),
    title: `Degradação em ${componente} · ${deviceType}`,
    devices,
    // affectedSessions alimenta impact.affectedSessions e chartMetric=affected_sessions.
    affectedSessions: Math.round(devices * (1.1 + rand() * 0.6)),
    startedMinutesAgo: minutesAgo,
    component: componente,
    deviceType,
    region,
    appVersion: pick(APP_VERSIONS),
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

  // ~70% dos incidentes já têm hipótese registrada; o resto exercita o
  // caminho "not_started" / AGENTIC_RESULT_UNAVAILABLE de /diagnosis.
  if (rand() < 0.7) {
    items.push({
      ...base,
      sk: hypothesisSk(incident.id, 1),
      incidentId: incident.id,
      text: `Causa provável em ${incident.component} afetando ${incident.deviceType} na região ${incident.region}`,
      score: Number((0.55 + rand() * 0.4).toFixed(2)),
      version: 0,
      reviewStatus: "pending",
      source: "seed-carga",
      createdAt: new Date().toISOString(),
    });
  }

  return items;
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

/** Remove apenas dados de incidentes da tabela operacional. Outros domínios
 *  compartilhados (ex.: contas de usuário) são preservados. */
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

  console.log(`Gerando ${total} incidentes (${INCIDENTS_PER_HOUR}/hora × ${HOURS_BACK} h) em ${OPERATIONAL_TABLE}…`);

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

  console.log("\nPronto. Para o k6:");
  console.log(`  INCIDENT_COUNT=${total}`);
  console.log("\n⚠️  Os buckets são relativos ao INSTANTE do seed.");
  console.log("    Rode o teste logo em seguida: window=15m só encontra dado por ~1 h.");
  console.log("\nLembrete: /api/v1/dashboard/overview e /api/v1/monitoring/overview NÃO são");
  console.log("populados por este seed — dependem de uma projeção que só a Ingestão publica");
  console.log("(ainda não implementada). Eles responderão 503 DATA_UNAVAILABLE, e é esperado.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Falha ao semear:", error);
    process.exit(1);
  });
}

module.exports = { enviarLoteComRetry, limparTabela, hourBucket, incidentSk, evidenceSk, hypothesisSk };

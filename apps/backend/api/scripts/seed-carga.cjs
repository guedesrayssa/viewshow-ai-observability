/**
 * Seed de CARGA para monitoracao-operacional. Usado pela suíte k6 em
 * apps/backend/api/loadtest/ para medir algo real, não vazio:
 *
 *   - volume suficiente para a resposta de /api/v1/incidents ter tamanho de
 *     produção;
 *   - incidentes distribuídos por TODOS os buckets de hora que a consulta
 *     varre, para que window=15m, 1h e 24h exerçam caminhos diferentes;
 *   - IDs ordinais e determinísticos (inc-000001 …), para o k6 sortear alvos
 *     sem precisar ler um manifesto;
 *   - a maioria dos incidentes já com hipótese registrada, para /diagnosis
 *     exercitar tanto o caminho "pronto" quanto o "not_started";
 *   - snapshots de projeção para dashboard/overview e monitoring/overview
 *     (pk `VIEW#OVERVIEW#GLOBAL#<YYYYMMDD>` / `VIEW#MONITORING#<fonte>#<YYYYMMDD>`,
 *     sk `T#<epochMs>`, item `{ publicData, observedThrough, coverageRatio,
 *     source }`), em várias idades para cobrir os presets de window de 15m a
 *     24h — ver `buildViewItems()`. Quando o snapshot sai da janela, a API
 *     consulta o último item retido e sinaliza STALE_SNAPSHOT. Depois do TTL,
 *     as rotas voltam a responder 503 DATA_UNAVAILABLE. `auth-check.js` tolera 200 ou 503
 *     (só verifica controle de acesso), mas os checks de `consultas.js`
 *     exigem 200: rode o seed imediatamente antes de cada rodada de carga.
 *
 * Extensão `.cjs` (não `.js`) de propósito: `package.json` declara
 * `"type": "module"`, então um `.js` aqui seria carregado como ESM e
 * `require`/`module.exports` quebrariam.
 *
 * USO: node scripts/seed-carga.cjs (a partir de apps/backend/api)
 *
 * Variáveis:
 *   OPERATIONAL_TABLE_NAME  padrão monitoracao-operacional (mesma da API)
 *   INCIDENTS_PER_HOUR      padrão 12
 *   HOURS_BACK              padrão 25   (cobre window=24h, que varre até 25 buckets)
 *   EVIDENCE_MIN/MAX        padrão 4/8
 *   MONITORING_SOURCES      padrão argus (mesma env var e default da API)
 *   CLEAN=1                 remove itens de incidentes e projeções (pk=INC#.../VIEW#...) antes de semear
 */

// dotenv não é dependência de apps/backend/api (só AWS SDK/zod/express) —
// carregar .env é conveniência opcional para quem tiver o pacote global ou
// instalado à parte, nunca um requisito para rodar o seed.
try {
  require("dotenv").config({ quiet: true });
} catch {
  /* sem dotenv instalado: segue lendo apenas process.env já exportado */
}
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { createHash } = require("node:crypto");
const {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

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
const evidenceSk = (id, seq) =>
  `EVIDENCE#${id}#${String(seq).padStart(3, "0")}`;
const hypothesisSk = (id, seq) =>
  `HYPOTHESIS#${id}#${String(seq).padStart(10, "0")}`;
const eventSk = (id, seq) => `EVENT#${id}#${String(seq).padStart(3, "0")}`;

const REGION = process.env.AWS_REGION || "us-east-1";
const OPERATIONAL_TABLE =
  process.env.OPERATIONAL_TABLE_NAME || "monitoracao-operacional";
// Mesma env var usada pela API (ex.: apps/backend/api/src/modules/dashboard/config.ts)
// para apontar ao DynamoDB Local. Sem isso o cliente sempre resolve a AWS real.
const ENDPOINT = process.env.DYNAMODB_ENDPOINT || undefined;

/** Mesma validação de apps/backend/api/scripts/live-e2e-runtime.mjs
 *  (requireDynamoDbEndpoint) — replicada aqui porque este arquivo é CommonJS
 *  e aquele é ESM. Usada só para travar CLEAN=1 (ver main()); achado de
 *  revisão: sem isso, CLEAN=1 apaga todo pk INC#/VIEW# em QUALQUER tabela
 *  que as credenciais/endpoint ativos resolverem, inclusive AWS real se
 *  DYNAMODB_ENDPOINT não estiver definido. */
function pareceEndpointLocal(endpoint) {
  if (!endpoint) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  const isCiService = endpoint === "http://dynamodb:8000";
  return isLoopback || isCiService;
}

const INCIDENTS_PER_HOUR = Number(process.env.INCIDENTS_PER_HOUR || 12);
const HOURS_BACK = Number(process.env.HOURS_BACK || 25);
const EVIDENCE_MIN = Number(process.env.EVIDENCE_MIN || 4);
const EVIDENCE_MAX = Number(process.env.EVIDENCE_MAX || 8);
const SEED_RUN_ID = (process.env.SEED_RUN_ID || "").trim();

// Mesma env var e default de apps/backend/api/src/modules/dashboard/config.ts.
const MONITORING_SOURCES = (process.env.MONITORING_SOURCES || "argus")
  .split(",")
  .map((source) => source.trim())
  .filter(Boolean);

// Idades (minutos) dos snapshots VIEW# gravados por buildViewItems(). Cobrem
// os presets de window da API (15m/30m/1h/6h/24h): cada preset só encontra
// dado se algum snapshot tiver idade menor que ele NO MOMENTO DA CONSULTA —
// como a idade é fixada na hora do seed, esses snapshots envelhecem igual
// aos incidentes (ver aviso no fim de main()).
const VIEW_SNAPSHOT_AGES_MINUTES = [1, 20, 45, 300, 1200];

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
  }),
);

const TTL_SECONDS_FROM_NOW = 30 * 24 * 60 * 60;
const ttl = () => Math.floor(Date.now() / 1000) + TTL_SECONDS_FROM_NOW;

/* ---------- dimensões, tiradas do vocabulário real do DATASET.md ---------- */

const COMPONENTES = [
  "Player",
  "CDN",
  "DRM",
  "Identidade",
  "API GraphQL",
  "Origem",
  "Borda",
  "Redis",
];
const DEVICE_TYPES = ["Smart TV", "Mobile", "Web", "Multiplataforma"];
const REGIOES = [
  "Norte",
  "Nordeste",
  "Centro-Oeste",
  "Sudeste",
  "Sul",
  "Nacional",
];
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
const FONTES = [
  "Player",
  "Youbora",
  "Fastly",
  "Prometheus",
  "New Relic",
  "Apollo",
  "RPaaS",
  "Cloud Armor",
];
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
    id: `inc-${SEED_RUN_ID ? `${SEED_RUN_ID}-` : ""}${String(ordinal).padStart(6, "0")}`,
    minutesAgo,
    urgency: pick(URGENCIAS),
    title: `Degradação em ${componente} · ${deviceType}`,
    devices,
    // affectedSessions alimenta impact.affectedSessions e chartMetric=affected_sessions.
    affectedSessions: Math.round(devices * (1.1 + rand() * 0.6)),
    startedAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
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
  const bucket = hourBucket(
    new Date(Date.now() - incident.minutesAgo * 60 * 1000),
  );
  const base = { pk: bucket, trace_id: incident.id, ttl: ttl() };
  const items = [];

  const { minutesAgo, ...incidentFields } = incident;
  const referenceNow = new Date();
  const bufferingPoints = [0.8, 0.9, 1.1, 1.4, 2.1, 3.2, 4.0, 3.6].map(
    (value, index) => ({
      timestamp: new Date(
        referenceNow.getTime() - (7 - index) * 15 * 60_000,
      ).toISOString(),
      value,
    }),
  );
  const timeline = [
    {
      offset: -10,
      label: `Versão ${incident.appVersion}`,
      source: "seed-carga",
      tone: "info",
    },
    {
      offset: -5,
      label: "Aumento de buffering",
      source: incident.component,
      tone: "warning",
    },
    {
      offset: 0,
      label: "Incidente detectado",
      source: "Argus",
      tone: "critical",
    },
    {
      offset: 5,
      label: "Evidências coletadas",
      source: "seed-carga",
      tone: "navy",
    },
  ].map((mark) => ({
    timestamp: new Date(
      Math.min(
        referenceNow.getTime(),
        new Date(incident.startedAt).getTime() + mark.offset * 60_000,
      ),
    ).toISOString(),
    label: mark.label,
    source: mark.source,
    tone: mark.tone,
  }));
  items.push({
    ...base,
    sk: incidentSk(incident.id),
    ...incidentFields,
    diagnosisProjection: {
      buffering: {
        points: bufferingPoints,
        marker: {
          timestamp: bufferingPoints[5].timestamp,
          label: "Início da degradação",
        },
      },
      concentrations: [
        { label: incident.deviceType, percentage: 68 },
        { label: incident.appVersion, percentage: 54 },
        { label: incident.region, percentage: 42 },
      ],
      concentrationNote: "Distribuição sintética dos dispositivos afetados",
      timeline,
      changes: [
        {
          label: "Provável",
          cause: incident.component,
          percentage: 72,
          tone: "critical",
        },
        {
          label: "Possível",
          cause: incident.appVersion,
          percentage: 28,
          tone: "warning",
        },
      ],
    },
  });

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
      title: `Desvio em ${incident.component}`,
      statement: `Métrica de ${incident.component} fora da linha de base em ${incident.region}`,
      source: pick(FONTES),
      strength: pick(FORCAS),
      qualityStatus: "verified",
      capturedAt: referenceNow.toISOString(),
    });
  }

  // ~70% dos incidentes já têm hipótese registrada; o resto exercita o
  // caminho "not_started" / AGENTIC_RESULT_UNAVAILABLE de /diagnosis.
  if (
    incident.id.endsWith("000001") ||
    incident.id.endsWith("000002") ||
    rand() < 0.7
  ) {
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

  const categories = [
    "request",
    "vitals",
    "screen_view",
    "video_view",
    "session",
    "error",
  ];
  for (let i = 1; i <= categories.length; i += 1) {
    const category = categories[i - 1];
    const timestamp = new Date(
      Math.min(Date.now(), new Date(incident.startedAt).getTime() + i * 60_000),
    ).toISOString();
    items.push({
      ...base,
      sk: eventSk(incident.id, i),
      incidentId: incident.id,
      publicData: {
        id: `evt-${incident.id}-${String(i).padStart(3, "0")}`,
        timestamp,
        category,
        source: { name: "seed-carga" },
        entity: incident.component,
        summary: `${category.replaceAll("_", " ")} em ${incident.component} · ${incident.deviceType}`,
        quality: { status: "verified", label: "Sintético" },
        dimensions: {
          deviceType: incident.deviceType,
          region: incident.region,
          appVersion: incident.appVersion,
        },
        normalized: {
          metric: category === "error" ? "errors_per_minute" : "event_count",
          value: "1",
          tags: [incident.component, incident.region],
        },
        raw: { available: false },
      },
    });
  }

  return items;
}

/* ---------- projeções VIEW#OVERVIEW / VIEW#MONITORING ---------- */

const viewDayBucket = (date) =>
  date.toISOString().slice(0, 10).replaceAll("-", "");
const viewSk = (date) => `T#${date.getTime()}`;

function measurementNow(now, coverageRatio = 1) {
  return {
    status: "measured",
    source: "seed-carga",
    coverageRatio,
    observedThrough: now.toISOString(),
  };
}

/** Formato espelha overviewProjectionSchema (contracts/src/index.ts), mas
 *  não é validado em runtime por DashboardQueries.overview() — só precisa
 *  não conter campos físicos (pk/sk/ttl/gsi*, ver assertNoPhysicalFields). */
function buildOverviewProjection(now, incidents = []) {
  const recentIncidents = incidents
    .filter((incident) => new Date(incident.startedAt) <= now)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 6)
    .map((incident) => ({
      id: incident.id,
      title: incident.title,
      priority: incident.urgency,
      status: incident.statusLabel,
      startedAt: incident.startedAt,
      affectedSessions: {
        value: incident.affectedSessions,
        measurement: measurementNow(now),
      },
    }));
  return {
    capabilities: {
      filtering: {
        status: "partial",
        supportedDimensions: ["deviceType", "region", "appVersion"],
        supportedFilterSets: [[], ["deviceType"], ["region"], ["appVersion"]],
      },
    },
    kpis: [
      {
        key: "errors_per_minute",
        value: 13,
        unit: "errors_per_minute",
        status: "healthy",
        comparison: {
          baselineValue: 121000,
          absoluteChange: 7000,
          changeRatio: 0.058,
          direction: "up",
        },
        measurement: measurementNow(now),
      },
      {
        key: "latency_p95",
        value: 1200,
        unit: "milliseconds",
        status: "warning",
        comparison: {
          baselineValue: 0.3,
          absoluteChange: 0.1,
          changeRatio: 0.33,
          direction: "up",
        },
        measurement: measurementNow(now),
      },
      {
        key: "affected_sessions",
        value: recentIncidents.reduce(
          (sum, incident) => sum + incident.affectedSessions.value,
          0,
        ),
        unit: "sessions",
        status: "warning",
        comparison: null,
        measurement: measurementNow(now),
      },
    ],
    experienceHealth: {
      metric: "errors_per_minute",
      unit: "errors_per_minute",
      bucketSeconds: 900,
      baselineValue: 12,
      measurement: measurementNow(now),
      points: [0, 1, 2, 3].map((i) => ({
        timestamp: new Date(
          now.getTime() - (3 - i) * 15 * 60 * 1000,
        ).toISOString(),
        value: 10 + i,
      })),
      anomalyWindows: [],
    },
    recentIncidents,
    facets: {},
  };
}

/** Formato espelha monitoringProjectionSchema. Mesma observação de runtime
 *  da função acima. */
function buildMonitoringProjection(source, now) {
  const kpi = (value, unit, status) => ({
    value,
    unit,
    status,
    measurement:
      value === null
        ? { ...measurementNow(now), status: "unknown" }
        : measurementNow(now),
  });
  const measured = (value, unit) => ({
    value,
    unit,
    measurement: measurementNow(now),
  });
  const flowSeries = [1.1, 1.0, 1.2, 1.4, 1.3, 1.5, 1.2, 1.1].map(
    (processing, index) => ({
      timestamp: new Date(
        now.getTime() - (7 - index) * 10 * 60_000,
      ).toISOString(),
      processing,
      ingestion: Number((processing * 0.35).toFixed(2)),
    }),
  );
  const peakFlow = flowSeries.reduce((peak, point) =>
    point.processing > peak.processing ? point : peak,
  );
  const areas = [
    ["SP", "São Paulo", "Sudeste", 0.021, 1400, 0.002],
    ["RJ", "Rio de Janeiro", "Sudeste", 0.017, 1300, 0.003],
    ["MG", "Minas Gerais", "Sudeste", 0.012, 1200, 0.001],
    ["BA", "Bahia", "Nordeste", 0.029, 1700, 0.004],
    ["PE", "Pernambuco", "Nordeste", 0.024, 1550, 0.003],
    ["RS", "Rio Grande do Sul", "Sul", 0.01, 1100, 0.001],
  ].map(([code, name, region, instability, latency, loss]) => ({
    code,
    name,
    region,
    observedSessions: measured(18000, "sessions"),
    coverageRatio: measured(0.99, "ratio"),
    values: {
      instabilityRatio: measured(instability, "ratio"),
      latencyP95: measured(latency, "ms"),
      eventLossRatio: measured(loss, "ratio"),
    },
  }));
  return {
    capabilities: {
      sourceQuality: { status: "available" },
      pipelineRuntime: {
        status: "available",
        metrics: {
          ingestionRate: "available",
          processingLatencyP95: "available",
          queueDepth: "unavailable",
          deadLetterQueue: "unavailable",
        },
        reason: null,
      },
      geographicMetrics: { status: "available", granularity: "state" },
      filtering: {
        status: "partial",
        supportedDimensions: [],
        supportedFilterSets: [[]],
      },
    },
    kpis: {
      ingestionRate: kpi(9800, "events_per_minute", "healthy"),
      processingLatencyP95: kpi(1200, "ms", "healthy"),
      queueDepth: kpi(null, "messages", "unknown"),
      deadLetterQueue: {
        ...kpi(null, "messages", "unknown"),
        newInWindow: null,
      },
    },
    flow: {
      metric: "processing_latency",
      unit: "ms",
      bucketSeconds: 900,
      measurement: measurementNow(now),
      target: null,
      series: [
        {
          stage: "processing",
          name: "Processamento",
          points: flowSeries.map((point) => ({
            timestamp: point.timestamp,
            value: Math.round(point.processing * 1000),
          })),
        },
      ],
      peak: {
        timestamp: peakFlow.timestamp,
        stage: "processing",
        value: Math.round(peakFlow.processing * 1000),
      },
    },
    sources: [
      {
        id: source,
        name: source,
        type: "batch",
        workers: [`${source}-worker-1`],
        lastRunAt: now.toISOString(),
        lastSuccessfulRunAt: now.toISOString(),
        observedThrough: now.toISOString(),
        lagSeconds: 60,
        state: "stable",
        ingestionRate: kpi(9800, "events_per_minute", "healthy"),
        processingLatencyP95: kpi(1200, "ms", "healthy"),
        records: {
          read: 15000,
          written: 14950,
          rejected: 50,
          measurement: measurementNow(now),
        },
        coverage: {
          value: 0.99,
          unit: "ratio",
          measurement: measurementNow(now),
        },
      },
    ],
    geography: {
      granularity: "state",
      metrics: [
        { key: "instability_ratio", unit: "ratio", status: "available" },
        { key: "latency_p95", unit: "ms", status: "available" },
        { key: "event_loss_ratio", unit: "ratio", status: "available" },
      ],
      areas,
    },
    topology: {
      status: "available",
      provenance: "seed-carga",
      services: [
        {
          service: "Player",
          status: "healthy",
          calls: 12000,
          errors: 42,
          errorRate: 0.0035,
          latencyP95: 120,
        },
        {
          service: "API GraphQL",
          status: "degraded",
          calls: 8200,
          errors: 410,
          errorRate: 0.05,
          latencyP95: 950,
        },
        {
          service: "CDN",
          status: "healthy",
          calls: 18000,
          errors: 54,
          errorRate: 0.003,
          latencyP95: 85,
        },
      ],
      dependencies: [
        {
          source: "Player",
          target: "API GraphQL",
          calls: 8000,
          errorRate: 0.05,
        },
        { source: "Player", target: "CDN", calls: 17000, errorRate: 0.003 },
      ],
    },
    facets: {},
  };
}

/** Um snapshot por idade em VIEW_SNAPSHOT_AGES_MINUTES, para overview (fonte
 *  GLOBAL) e para cada fonte de MONITORING_SOURCES — assim window=15m,
 *  30m/1h/6h/24h encontram algum item recente o bastante logo após a seed. */
function buildViewItems(referenceNow, incidents = []) {
  const items = [];
  for (const minutesAgo of VIEW_SNAPSHOT_AGES_MINUTES) {
    const at = new Date(referenceNow.getTime() - minutesAgo * 60 * 1000);
    const day = viewDayBucket(at);
    const sk = viewSk(at);

    items.push({
      pk: `VIEW#OVERVIEW#GLOBAL#${day}`,
      sk,
      publicData: buildOverviewProjection(at, incidents),
      observedThrough: at.toISOString(),
      coverageRatio: 0.97,
      source: "argus",
      ttl: ttl(),
    });

    for (const source of MONITORING_SOURCES) {
      items.push({
        pk: `VIEW#MONITORING#${source}#${day}`,
        sk,
        publicData: buildMonitoringProjection(source, at),
        observedThrough: at.toISOString(),
        coverageRatio: 0.95,
        source,
        ttl: ttl(),
      });
    }
  }
  return items;
}

/* ---------- contrato versionado consumido pela API atual --------------- */

function compareUnicode(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) || 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) || 0);
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareUnicode(left, right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

const sha256 = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value), "utf8")
    .digest("hex");

function buildVersionedItems(referenceNow, incidents) {
  const observedThrough = referenceNow.toISOString();
  const start = new Date(
    referenceNow.getTime() - HOURS_BACK * 60 * 60 * 1000,
  ).toISOString();
  const end = new Date(referenceNow.getTime() + 60_000).toISOString();
  const datasetVersion = `dsv_${sha256(`seed-carga:${SEED_RUN_ID || observedThrough}`)}`;
  const materializationRevision = `pmr_${sha256(`${datasetVersion}:projections`)}`;
  const sourceDataset = "incidents";
  const day = referenceNow.toISOString().slice(0, 10).replaceAll("-", "");
  const incidentPayload = {
    projectionVersion: "1.0",
    formulaVersion: "seed-carga-1.0",
    inputWatermarks: { [sourceDataset]: observedThrough },
    observedThrough,
    coverage: "complete",
    qualityFlags: [],
    incidents: incidents.map((incident) => ({
      incidentId: incident.id,
      number: null,
      openedAt: incident.startedAt,
      state: incident.status === "success" ? "resolved" : "investigating",
      priority: incident.urgency,
    })),
  };
  const overviewPayload = {
    projectionVersion: "1.0",
    formulaVersion: "seed-carga-1.0",
    inputWatermarks: { [sourceDataset]: observedThrough },
    observedThrough,
    coverage: "complete",
    qualityFlags: [],
    metrics: {
      sessions: incidents.reduce(
        (total, item) => total + item.affectedSessions,
        0,
      ),
      errors: incidents.length,
      startupErrors: Math.round(incidents.length * 0.2),
      botErrors: Math.round(incidents.length * 0.1),
      humanErrors: Math.round(incidents.length * 0.9),
      errorRate: Math.min(
        1,
        incidents.length /
          Math.max(
            1,
            incidents.reduce((total, item) => total + item.affectedSessions, 0),
          ),
      ),
    },
  };
  const projectionBase = {
    entityType: "PROJECTION",
    datasetVersion,
    projectionVersion: "1.0",
    materializationRevision,
    requiredArchives: [],
  };
  const incidentsPk = `DATASET#${datasetVersion}#VIEW#INCIDENTS#ACTIVE`;
  const overviewPk = `DATASET#${datasetVersion}#VIEW#OVERVIEW#${sourceDataset}#${day}`;
  const metadata = {
    availableIntervals: { [sourceDataset]: [{ start, end }] },
    formulaVersions: {
      incidents: "seed-carga-1.0",
      overview: "seed-carga-1.0",
    },
    hotFrom: { [sourceDataset]: start },
    projectionVersions: { incidents: "1.0", overview: "1.0" },
  };

  return [
    {
      pk: incidentsPk,
      sk: "CURRENT",
      ...projectionBase,
      partition: "ACTIVE",
      projectionPartitionKey: incidentsPk,
      projectionKey: "INCIDENTS#ACTIVE",
      payload: incidentPayload,
      payloadFingerprint: sha256(incidentPayload),
    },
    {
      pk: overviewPk,
      sk: `T#${referenceNow.getTime()}`,
      ...projectionBase,
      partition: day,
      projectionPartitionKey: overviewPk,
      projectionKey: `OVERVIEW#${sourceDataset}`,
      payload: overviewPayload,
      payloadFingerprint: sha256(overviewPayload),
    },
    {
      pk: "CONTROL#DATASET",
      sk: "ACTIVE",
      entityType: "ACTIVE_MANIFEST",
      activeDatasetVersion: datasetVersion,
      manifest: {
        datasetVersion,
        metadata,
        fingerprint: sha256({ datasetVersion, metadata }),
      },
    },
  ];
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
  {
    documentClient = client,
    wait = esperarBackoff,
    maxAttempts = MAX_BATCH_ATTEMPTS,
  } = {},
) {
  let pendentes = { [tableName]: requests };

  for (let tentativa = 0; tentativa < maxAttempts; tentativa += 1) {
    const resposta = await documentClient.send(
      new BatchWriteCommand({ RequestItems: pendentes }),
    );
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

/** Remove apenas os dados que este script escreve (incidentes + projeções de
 *  overview/monitoring). Outros domínios compartilhados (ex.: contas de
 *  usuário) são preservados. */
async function limparTabela(
  tableName,
  {
    documentClient = client,
    wait = esperarBackoff,
    maxAttempts = MAX_BATCH_ATTEMPTS,
  } = {},
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
      ({ pk }) =>
        typeof pk === "string" &&
        (pk.startsWith("INC#") || pk.startsWith("VIEW#")),
    );
    for (let i = 0; i < itens.length; i += 25) {
      const lote = itens.slice(i, i + 25);
      const requests = lote.map(({ pk, sk }) => ({
        DeleteRequest: { Key: { pk, sk } },
      }));
      await enviarLoteComRetry(tableName, requests, {
        documentClient,
        wait,
        maxAttempts,
      });
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

  if (!pareceEndpointLocal(ENDPOINT) && process.env.ALLOW_REMOTE_SEED !== "1") {
    throw new Error(
      "Seed remoto recusado: defina DYNAMODB_ENDPOINT para DynamoDB Local " +
        "ou ALLOW_REMOTE_SEED=1 somente em um ambiente isolado e autorizado.",
    );
  }

  if (process.env.CLEAN === "1") {
    if (!pareceEndpointLocal(ENDPOINT)) {
      throw new Error(
        "CLEAN=1 recusado: DYNAMODB_ENDPOINT precisa apontar para um endereço " +
          "local (http://127.0.0.1:... ou http://localhost:... ou http://dynamodb:8000 " +
          `em CI) — valor atual: ${ENDPOINT ?? "(não definido — resolveria para a AWS real)"}. ` +
          "Isso existe para não apagar itens de uma tabela remota por engano: CLEAN " +
          "remove incondicionalmente todo item cujo pk comece com INC# ou VIEW# na " +
          "tabela e no endpoint que as credenciais ativas resolverem.",
      );
    }
    console.log(`Limpando ${OPERATIONAL_TABLE} em ${ENDPOINT}…`);
    const removidos = await limparTabela(OPERATIONAL_TABLE);
    console.log(`  ${removidos} itens removidos.`);
  }

  console.log(
    `Gerando ${total} incidentes (${INCIDENTS_PER_HOUR}/hora × ${HOURS_BACK} h) em ${OPERATIONAL_TABLE}…`,
  );

  const itens = [];
  const incidentes = [];
  let ordinal = 0;
  for (let hora = 0; hora < HOURS_BACK; hora += 1) {
    for (let n = 0; n < INCIDENTS_PER_HOUR; n += 1) {
      ordinal += 1;
      // espalha dentro da hora para não concentrar tudo no minuto cheio
      const minutesAgo = hora * 60 + intBetween(1, 59);
      const incident = buildIncident(ordinal, minutesAgo);
      incidentes.push(incident);
      itens.push(...buildItems(incident));
    }
  }

  await batchWrite(OPERATIONAL_TABLE, itens);
  console.log(
    `  ${itens.length} itens gravados (incidentes + evidências + hipóteses + eventos).`,
  );

  const now = new Date();
  const viewItens = buildViewItems(now, incidentes);
  await batchWrite(OPERATIONAL_TABLE, viewItens);
  console.log(
    `  ${viewItens.length} itens de projeção gravados para /dashboard/overview e ` +
      `/monitoring/overview (fontes: ${MONITORING_SOURCES.join(", ")}).`,
  );

  const versionedItems = buildVersionedItems(now, incidentes);
  await batchWrite(OPERATIONAL_TABLE, versionedItems);
  console.log(
    `  ${versionedItems.length} itens do dataset versionado gravados (manifesto ACTIVE + projeções de incidentes e overview).`,
  );

  console.log("\nPronto. Para o k6:");
  console.log(`  INCIDENT_COUNT=${total}`);
  console.log("\n⚠️  Os buckets são relativos ao INSTANTE do seed.");
  console.log(
    "    Rode o teste logo em seguida: window=15m só encontra dado por ~1 h.",
  );
  console.log(
    "\n⚠️  /api/v1/dashboard/overview e /api/v1/monitoring/overview também envelhecem:",
  );
  console.log(
    `    snapshots gravados com ${VIEW_SNAPSHOT_AGES_MINUTES.join("/")} min de idade cobrem os presets`,
  );
  console.log(
    "    as janelas logo após o seed; depois a API mostra o último snapshot retido",
  );
  console.log("    com aviso STALE_SNAPSHOT, até o TTL removê-lo do DynamoDB.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Falha ao semear:", error);
    process.exit(1);
  });
}

module.exports = {
  enviarLoteComRetry,
  limparTabela,
  hourBucket,
  incidentSk,
  evidenceSk,
  hypothesisSk,
  buildViewItems,
  buildOverviewProjection,
  buildMonitoringProjection,
};

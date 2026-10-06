#!/usr/bin/env node
/**
 * Prova de ponta a ponta da observabilidade da API.
 *
 * Gera requisições com IDs conhecidos contra uma API em execução e confere,
 * nos backends reais (Loki, Tempo, Prometheus, Grafana), que:
 *   - cada requisição deixa UMA linha de log com nível conforme o status;
 *   - o trace existe, o span SERVER tem o nome da rota e o request_id;
 *   - do log chega-se ao trace e do trace aos logs (mesmo trace_id);
 *   - a latência tem exemplar apontando para o trace;
 *   - nenhum segredo (senha, code OIDC, e-mail) aparece em log ou trace;
 *   - health checks e scrapes de /metrics não geram log nem trace;
 *   - toda query de todo painel dos dashboards provisionados executa sem erro.
 *
 * Uso (com a stack e a API no ar; veja run-api-local.sh):
 *   AUTH_COOKIE_SECRET=<mesmo segredo da API> node verify-api-observability.mjs
 *
 * Variáveis: BASE_URL, LOKI_URL, TEMPO_URL, PROMETHEUS_URL, GRAFANA_URL,
 * GRAFANA_AUTH (usuario:senha). Sai com código 1 se qualquer verificação falhar.
 */
import { createHmac } from "node:crypto";

const env = (name, fallback) => process.env[name] ?? fallback;
const BASE = env("BASE_URL", "http://127.0.0.1:3000");
const LOKI = env("LOKI_URL", "http://localhost:3100");
const TEMPO = env("TEMPO_URL", "http://localhost:3200");
const PROM = env("PROMETHEUS_URL", "http://localhost:9090");
const GRAFANA = env("GRAFANA_URL", "http://localhost:3002");
const GRAFANA_AUTH = env("GRAFANA_AUTH", "admin:admin");
const SECRET = env("AUTH_COOKIE_SECRET", "");
const RUN = `verify-${Date.now().toString(36)}`;
const SECRET_CODE = `OIDCCODE${Date.now().toString(36)}`;
const SECRET_PASSWORD = `Pw!${Date.now().toString(36)}-NEVER-LOG`;
const SECRET_EMAIL = `${RUN}@globoplay.com`;

if (!SECRET) {
  console.error("Defina AUTH_COOKIE_SECRET (o mesmo segredo usado pela API).");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FALHA"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, probe, { timeoutMs = 60_000, everyMs = 2_000 } = {}) {
  const limit = Date.now() + timeoutMs;
  let last;
  while (Date.now() < limit) {
    try {
      last = await probe();
      if (last) return last;
    } catch {
      // backend ainda subindo ou dado ainda não indexado
    }
    await sleep(everyMs);
  }
  return undefined;
}
const json = async (url, init) => (await fetch(url, init)).json();

function sessionCookie() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      id: "verify-user",
      email: SECRET_EMAIL,
      name: null,
      role: "engineer",
      issuedAt,
      expiresAt: issuedAt + 3600,
      sessionId: `${RUN}-session`,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `session=${payload}.${signature}`;
}

async function call(label, method, path, { auth = true, body } = {}) {
  const requestId = `${RUN}-${label}`;
  const response = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      "x-request-id": requestId,
      ...(auth ? { cookie: sessionCookie() } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  await response.arrayBuffer();
  return {
    requestId,
    status: response.status,
    traceId: response.headers.get("x-trace-id"),
    echoedRequestId: response.headers.get("x-request-id"),
  };
}

async function lokiLines(query, windowSeconds = 900) {
  const params = new URLSearchParams({
    query,
    limit: "200",
    start: `${(Math.floor(Date.now() / 1000) - windowSeconds) * 1e9}`,
  });
  const body = await json(`${LOKI}/loki/api/v1/query_range?${params}`);
  return (body.data?.result ?? []).flatMap((stream) =>
    stream.values.map(([, line]) => ({ stream: stream.stream, line, parsed: safeParse(line) })),
  );
}
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
}

async function tempoTrace(traceId) {
  const response = await fetch(`${TEMPO}/api/traces/${traceId}`);
  if (!response.ok) return undefined;
  const body = await response.json();
  const value = (v) => v.stringValue ?? v.intValue ?? v.boolValue ?? JSON.stringify(v);
  return (body.batches ?? body.resourceSpans ?? []).flatMap((batch) =>
    batch.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({
        name: span.name,
        kind: span.kind,
        status: span.status?.code ?? "UNSET",
        attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, value(a.value)])),
      })),
    ),
  );
}

async function main() {
  console.log(`\nVerificação ${RUN}\n`);
  const health = await fetch(`${BASE}/health`).catch(() => undefined);
  if (!health?.ok) {
    console.error(`API indisponível em ${BASE}. Suba-a antes (run-api-local.sh).`);
    process.exit(2);
  }

  console.log("1. Requisições de teste");
  const ok = await call("list", "GET", "/api/v1/incidents?window=1h");
  const bad = await call("bad", "GET", "/api/v1/incidents?window=bogus");
  const missing = await call("nope", "GET", "/api/v1/nope");
  const callback = await call("cb", "GET", `/auth/callback?code=${SECRET_CODE}&state=st-${RUN}`, { auth: false });
  const login = await call("login", "POST", "/auth/login", {
    auth: false,
    body: { username: SECRET_EMAIL, password: SECRET_PASSWORD },
  });
  await fetch(`${BASE}/health`);
  await fetch(`${BASE}/metrics`);
  check("API devolve X-Request-Id igual ao enviado", ok.echoedRequestId === ok.requestId);
  check("API devolve X-Trace-Id de 32 hex", /^[0-9a-f]{32}$/.test(ok.traceId ?? ""), ok.traceId ?? "sem header (OTEL_EXPORTER_OTLP_ENDPOINT definido?)");

  console.log("\n2. Logs no Loki");
  const access = await until("log de acesso", async () => {
    const lines = await lokiLines(`{service_name=~".*api"} | json | request_id=~"${RUN}-.*" | event="http.request.completed"`);
    return lines.length >= 4 ? lines : undefined;
  });
  const byId = (id) => access?.find((entry) => entry.parsed.request_id === id);
  check("linhas de acesso chegaram ao Loki", Boolean(access), `${access?.length ?? 0} linhas`);
  check("2xx em info", byId(ok.requestId)?.stream.level === "info");
  check("4xx em warn (400 e 404)", byId(bad.requestId)?.stream.level === "warn" && byId(missing.requestId)?.stream.level === "warn");
  check("5xx em error, com error_code", byId(callback.requestId)?.stream.level === "error" && Boolean(byId(callback.requestId)?.parsed.error_code), byId(callback.requestId)?.parsed.error_code);
  check("rota sem casamento vira 'unmatched'", byId(missing.requestId)?.parsed.route === "unmatched");
  check("rota é o template, não o path", byId(ok.requestId)?.parsed.route === "/api/v1/incidents");
  check("linha de acesso carrega trace_id igual ao X-Trace-Id", byId(ok.requestId)?.parsed.trace_id === ok.traceId);
  const loginEvent = (await lokiLines(`{service_name=~".*api"} | json | request_id="${login.requestId}" | event="auth.login.failed"`))[0];
  check("falha de login registra o motivo (insumo de RNF04)", Boolean(loginEvent?.parsed.reason), loginEvent?.parsed.reason);
  const probes = await lokiLines(`{service_name=~".*api"} | json | route=~"/health|/metrics" | event="http.request.completed"`, 120);
  check("/health e /metrics não geram log", probes.length === 0, `${probes.length} linhas`);
  const labels = (await json(`${LOKI}/loki/api/v1/labels`)).data ?? [];
  check("trace_id e request_id NÃO são rótulos do Loki", !labels.includes("trace_id") && !labels.includes("request_id"), labels.join(","));

  console.log("\n3. Traces no Tempo");
  const spans = await until("trace", async () => (ok.traceId ? await tempoTrace(ok.traceId) : undefined));
  const server = spans?.find((span) => span.kind === "SPAN_KIND_SERVER");
  check("trace da requisição existe", Boolean(spans), `${spans?.length ?? 0} spans`);
  check("span SERVER nomeado pela rota", server?.name === "GET /api/v1/incidents", server?.name);
  check("span SERVER guarda o request_id", server?.attributes["viewshow.request_id"] === ok.requestId);
  check("trace enxuto (sem spans de middleware)", spans ? !spans.some((s) => s.name.startsWith("middleware")) : false);
  const callbackSpans = callback.traceId ? await until("trace callback", async () => tempoTrace(callback.traceId)) : undefined;
  const callbackServer = callbackSpans?.find((span) => span.kind === "SPAN_KIND_SERVER");
  check("span de erro tem status ERROR e código de negócio", callbackServer?.status === "STATUS_CODE_ERROR" && Boolean(callbackServer?.attributes["viewshow.error_code"]), callbackServer?.attributes["viewshow.error_code"]);
  check("query do callback OIDC redigida no span", callbackServer?.attributes["url.query"] === "code=REDACTED&state=REDACTED", callbackServer?.attributes["url.query"]);
  const byRequest = await until("busca TraceQL por request_id", async () => {
    const params = new URLSearchParams({ q: `{ span.viewshow.request_id = "${ok.requestId}" }`, start: `${Math.floor(Date.now() / 1000) - 900}`, end: `${Math.floor(Date.now() / 1000)}` });
    const found = (await json(`${TEMPO}/api/search?${params}`)).traces ?? [];
    return found.length ? found : undefined;
  });
  check("TraceQL encontra o trace pelo request_id", byRequest?.[0]?.traceID === ok.traceId);

  console.log("\n4. Correlação entre sinais");
  const logsOfTrace = await lokiLines(`{service_name=~".*api"} |= "${ok.traceId}"`);
  check("trace → logs: filtrar o Loki pelo trace_id acha a requisição", logsOfTrace.some((entry) => entry.parsed.request_id === ok.requestId));
  const fromLog = byId(ok.requestId)?.parsed.trace_id;
  check("log → trace: o trace_id do log abre o mesmo trace", Boolean(fromLog) && Boolean(await tempoTrace(fromLog)));
  const exemplar = await until("exemplar", async () => {
    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ query: "http_request_duration_seconds_bucket", start: `${now - 900}`, end: `${now}` });
    const found = (await json(`${PROM}/api/v1/query_exemplars?${params}`)).data ?? [];
    return found.flatMap((series) => series.exemplars).find((e) => e.labels.trace_id === ok.traceId);
  }, { timeoutMs: 45_000, everyMs: 3_000 });
  check("métrica → trace: histograma de latência tem exemplar do trace", Boolean(exemplar));
  const spanMetrics = await until("spanmetrics", async () => {
    const body = await json(`${PROM}/api/v1/query?query=${encodeURIComponent('traces_spanmetrics_calls_total{span_name="GET /api/v1/incidents"}')}`);
    return body.data?.result?.length ? body.data.result : undefined;
  }, { timeoutMs: 45_000, everyMs: 3_000 });
  check("métricas RED derivadas de trace separam as rotas", Boolean(spanMetrics));
  const logins = await until("login metric", async () => {
    const body = await json(`${PROM}/api/v1/query?query=${encodeURIComponent('sum(auth_login_attempts_total{outcome!="success"})')}`);
    return Number(body.data?.result?.[0]?.value?.[1]) > 0 ? true : undefined;
  }, { timeoutMs: 45_000, everyMs: 3_000 });
  check("tentativas de login recusadas viram métrica", Boolean(logins));

  console.log("\n5. Nenhum segredo vaza");
  for (const [label, needle] of [["senha digitada", SECRET_PASSWORD], ["code OIDC", SECRET_CODE], ["e-mail do usuário", SECRET_EMAIL]]) {
    const inLogs = await lokiLines(`{service_name=~".*api"} |= "${needle}"`);
    check(`${label} ausente dos logs`, inLogs.length === 0);
  }
  const allTraceText = JSON.stringify([spans, callbackSpans, await tempoTrace(login.traceId ?? "0".repeat(32))]);
  check("segredos ausentes dos traces", ![SECRET_PASSWORD, SECRET_CODE, SECRET_EMAIL].some((needle) => allTraceText.includes(needle)));

  console.log("\n6. Grafana");
  const auth = `Basic ${Buffer.from(GRAFANA_AUTH).toString("base64")}`;
  const g = (path, init = {}) => fetch(GRAFANA + path, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) } }).then((r) => r.json());
  for (const uid of ["prometheus", "loki", "tempo"]) {
    const health = await g(`/api/datasources/uid/${uid}/health`);
    check(`data source ${uid} saudável`, health.status === "OK", health.message);
  }
  let queries = 0;
  let failed = 0;
  const dashboards = (await g("/api/search?type=dash-db")).filter((d) => d.uid.startsWith("view-show-") && d.uid !== "view-show-aws");
  check("dashboards View Show provisionados", dashboards.length >= 2, dashboards.map((d) => d.title).join(" | "));
  for (const summary of dashboards) {
    const { dashboard } = await g(`/api/dashboards/uid/${summary.uid}`);
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        const datasource = target.datasource ?? panel.datasource;
        const query = { ...target, datasource, intervalMs: 15000, maxDataPoints: 400 };
        if (datasource.type === "prometheus") Object.assign(query, { range: true, instant: false });
        if (datasource.type === "loki") Object.assign(query, { queryType: "range", maxLines: 50 });
        for (const key of ["expr", "query"]) if (typeof query[key] === "string") query[key] = query[key].replaceAll("$id", ok.requestId);
        const answer = await g("/api/ds/query", { method: "POST", body: JSON.stringify({ queries: [query], from: "now-30m", to: "now" }) });
        const error = answer.results?.[target.refId ?? "A"]?.error ?? answer.message;
        queries += 1;
        if (error) {
          failed += 1;
          console.log(`        painel com erro: ${dashboard.title} / ${panel.title}: ${String(error).slice(0, 120)}`);
        }
      }
    }
  }
  check("toda query de todo painel executa sem erro", failed === 0, `${queries} queries`);
  const byIdPanel = await g("/api/ds/query", { method: "POST", body: JSON.stringify({ queries: [{ refId: "A", datasource: { type: "tempo", uid: "tempo" }, queryType: "traceql", query: `{ span.viewshow.request_id = "${ok.requestId}" || trace:id = "${ok.requestId}" }`, tableType: "traces", limit: 5 }], from: "now-30m", to: "now" }) });
  check("painel 'Traces do ID' acha o trace pelo request_id", (byIdPanel.results?.A?.frames?.[0]?.data?.values?.[0]?.length ?? 0) > 0);

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} verificações passaram.`);
  if (failures.length) {
    console.log(`Falharam:\n${failures.map((f) => `  - ${f.name}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

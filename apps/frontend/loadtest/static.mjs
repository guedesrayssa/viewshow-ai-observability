import autocannon from "autocannon";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentFailure, contentTypeHeader, sha256 } from "./static-contract.mjs";

const baseUrl = new URL(process.env.BASE_URL || "http://127.0.0.1:4173/");
const profileName = process.env.PROFILE || "load";
const runLabel = process.env.RUN_LABEL || profileName;
const resultsDir = path.resolve(process.env.RESULTS_DIR || "loadtest/results");
const exportDir = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : null;
if (!/^[a-z0-9][a-z0-9-]*$/i.test(runLabel)) throw new Error("RUN_LABEL deve conter letras, números e hífens.");
if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.pathname !== "/" || baseUrl.username || baseUrl.password) {
  throw new Error("BASE_URL deve ser a origem HTTP(S), sem caminho ou credenciais.");
}
let revision = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* optional outside Git */ }
const fingerprints = [];
let contentErrors = 0;
let checkedResponses = 0;
const invalidSamples = [];

const profiles = {
  smoke: { connections: 2, duration: 15 },
  load: { connections: 50, duration: 60 },
  spike: { connections: 200, duration: 30 },
};

const pagePaths = [
  "/login/",
  "/visao-geral/",
  "/incidentes/",
  "/incidentes/detalhe/",
  "/incidentes/feed-eventos/",
  "/monitoramento/",
  "/dados/importacoes/",
];

const profile = profiles[profileName];
if (!profile) {
  throw new Error(`PROFILE deve ser ${Object.keys(profiles).join(", ")}.`);
}

async function inspect(requestPath) {
  const response = await fetch(new URL(requestPath, baseUrl), { redirect: "manual", signal: AbortSignal.timeout(8_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type");
  const failure = contentFailure(requestPath, response.status, type, bytes);
  if (failure) throw new Error(`Preflight de ${requestPath}: ${failure}.`);
  const hash = sha256(bytes);
  if (exportDir) {
    const file = requestPath.endsWith("/") ? `${requestPath}index.html` : requestPath.split("?")[0];
    const expectedPath = path.resolve(exportDir, decodeURIComponent(file).replace(/^\/+/, ""));
    if (!expectedPath.startsWith(exportDir + path.sep)) throw new Error("Static path escaped OUT_DIR");
    if (sha256(await readFile(expectedPath)) !== hash) throw new Error(`Preflight de ${requestPath}: difere da exportação local.`);
  }
  fingerprints.push({ path: requestPath, contentType: type, bytes: bytes.length, sha256: hash });
  return bytes.toString("utf8");
}

async function discoverRequests() {
  const discovered = new Set(pagePaths);

  for (const pagePath of pagePaths) {
    const html = await inspect(pagePath);
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const resource = new URL(match[1], baseUrl);
      if (resource.origin === baseUrl.origin && resource.pathname.startsWith("/_next/static/")) {
        discovered.add(`${resource.pathname}${resource.search}`);
      }
    }
  }

  if (discovered.size === pagePaths.length) throw new Error("Preflight não encontrou recursos Next.js; possível fallback HTML.");
  for (const resource of discovered) if (!pagePaths.includes(resource)) await inspect(resource);
  return [...discovered].map((requestPath) => ({
    method: "GET",
    path: requestPath,
    headers: { Accept: requestPath.endsWith("/") ? "text/html" : "*/*", "Accept-Encoding": "identity" },
    onResponse(status, body, _context, headers) {
      checkedResponses += 1;
      const reason = contentFailure(requestPath, status, contentTypeHeader(headers), body);
      if (reason) {
        contentErrors += 1;
        if (invalidSamples.length < 5) invalidSamples.push({ path: requestPath, status, reason });
      }
    },
  }));
}

let requests;
try {
  requests = await discoverRequests();
} catch (error) {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, `static-${runLabel}.json`), JSON.stringify({ schemaVersion: 2,
    profile: profileName, target: baseUrl.origin, revision, finishedAt: new Date().toISOString(),
    preflightError: error.message, thresholds: { validPreflight: false } }, null, 2) + "\n");
  console.error(error.message);
  process.exit(1);
}
const startedAt = new Date();
const result = await autocannon({
  url: baseUrl.origin,
  requests,
  connections: profile.connections,
  duration: profile.duration,
  pipelining: 1,
  timeout: 8,
});
const finishedAt = new Date();

const summary = {
  schemaVersion: 2,
  revision,
  profile: profileName,
  target: baseUrl.origin,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  configuration: { ...profile, pipelining: 1, timeoutSeconds: 8, contentValidation: true, exportHashChecked: Boolean(exportDir) },
  workload: {
    pages: pagePaths,
    discoveredStaticResources: requests.length - pagePaths.length,
    totalRequestVariants: requests.length,
    resources: fingerprints,
    sha256: sha256(JSON.stringify(fingerprints)),
  },
  results: {
    requests: result.requests,
    latency: result.latency,
    throughput: result.throughput,
    statusCodeStats: result.statusCodeStats,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    durationSeconds: result.duration,
    contentErrors,
    checkedResponses,
    invalidSamples,
  },
  thresholds: {
    noTransportErrors: result.errors === 0 && result.timeouts === 0,
    noHttpErrors: result.non2xx === 0,
    validContent: contentErrors === 0 && checkedResponses > 0,
    // O Autocannon publica p90 e p97,5. Exigir p97,5 < 200 ms também garante
    // que o p95 esteja abaixo do mesmo limite, sem inventar um percentil.
    latencyP97_5Below200ms: result.latency.p97_5 < 200,
  },
};

await mkdir(resultsDir, { recursive: true });
const output = path.join(resultsDir, `static-${runLabel}.json`);
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ output, ...summary }, null, 2));
if (Object.values(summary.thresholds).includes(false)) process.exitCode = 1;

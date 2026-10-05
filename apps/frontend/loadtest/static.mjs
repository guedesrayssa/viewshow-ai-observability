import autocannon from "autocannon";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = new URL(process.env.BASE_URL || "http://127.0.0.1:4173/");
const profileName = process.env.PROFILE || "load";
const runLabel = process.env.RUN_LABEL || profileName;
const resultsDir = path.resolve(process.env.RESULTS_DIR || "loadtest/results");

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

async function discoverRequests() {
  const discovered = new Set(pagePaths);

  for (const pagePath of pagePaths) {
    const response = await fetch(new URL(pagePath, baseUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status !== 200) {
      throw new Error(`Preflight de ${pagePath} retornou HTTP ${response.status}.`);
    }

    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const resource = new URL(match[1], baseUrl);
      if (resource.origin === baseUrl.origin && resource.pathname.startsWith("/_next/static/")) {
        discovered.add(`${resource.pathname}${resource.search}`);
      }
    }
  }

  return [...discovered].map((requestPath) => ({
    method: "GET",
    path: requestPath,
    headers: { Accept: requestPath.endsWith("/") ? "text/html" : "*/*" },
  }));
}

const requests = await discoverRequests();
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
  schemaVersion: 1,
  profile: profileName,
  target: baseUrl.origin,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  configuration: { ...profile, pipelining: 1, timeoutSeconds: 8 },
  workload: {
    pages: pagePaths,
    discoveredStaticResources: requests.length - pagePaths.length,
    totalRequestVariants: requests.length,
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
  },
  thresholds: {
    noTransportErrors: result.errors === 0 && result.timeouts === 0,
    noHttpErrors: result.non2xx === 0,
    // O Autocannon publica p90 e p97,5. Exigir p97,5 < 200 ms também garante
    // que o p95 esteja abaixo do mesmo limite, sem inventar um percentil.
    latencyP97_5Below200ms: result.latency.p97_5 < 200,
  },
};

await mkdir(resultsDir, { recursive: true });
if (!/^[a-z0-9][a-z0-9-]*$/i.test(runLabel)) {
  throw new Error("RUN_LABEL deve conter apenas letras, números e hífens.");
}
const output = path.join(resultsDir, `static-${runLabel}.json`);
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ output, ...summary }, null, 2));
if (Object.values(summary.thresholds).includes(false)) process.exitCode = 1;

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const loadtestDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(loadtestDir, "..");
const repoRoot = path.resolve(loadtestDir, "../../../..");
const region = process.env.AWS_REGION || "us-east-1";
const expectedAccount = process.env.EXPECTED_AWS_ACCOUNT_ID;
const cluster = process.env.ECS_CLUSTER || "view-show-iac-cluster";
const serviceName = process.env.ECS_SERVICE || "view-show-iac-api-service";
const containerName = process.env.API_CONTAINER || "view-show-iac-api";
const mode = process.env.MODE || "smoke";
const rate = process.env.RATE || (mode === "smoke" ? "1" : "50");
const duration = process.env.DURATION;
const resultsDir = path.resolve(
  loadtestDir,
  process.env.RESULTS_DIR || "results/aws",
);

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    env: options.env || process.env,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function terraformOutput(name) {
  return command("terraform", ["-chdir=apps/fullstack", "output", "-raw", name], {
    cwd: repoRoot,
  });
}

function awsJson(args) {
  return JSON.parse(
    command("aws", [...args, "--region", region, "--no-cli-pager", "--output", "json"]),
  );
}

if (!/^\d{12}$/.test(expectedAccount || "")) {
  throw new Error("Set EXPECTED_AWS_ACCOUNT_ID to the 12-digit AWS account for this test.");
}

const account = command("aws", [
  "sts",
  "get-caller-identity",
  "--query",
  "Account",
  "--output",
  "text",
  "--region",
  region,
]);
if (account !== expectedAccount) {
  throw new Error(`AWS account mismatch: expected ${expectedAccount}, received ${account}.`);
}

// `api` (padrão) fala direto com o API Gateway. `amplify` usa o endereço do
// painel, por onde o navegador de verdade entra: o Amplify repassa /api, /auth
// e /health ao mesmo API Gateway, então o caminho ganha um salto a mais. Use
// taxas baixas nesse alvo — é um serviço gerenciado compartilhado, não a API.
const target = process.env.TARGET || "api";
if (!["api", "amplify"].includes(target)) {
  throw new Error("TARGET deve ser api ou amplify.");
}
const baseUrl = terraformOutput(target === "amplify" ? "painel_url" : "api_url_https").replace(
  /\/$/,
  "",
);
const service = awsJson(["ecs", "describe-services", "--cluster", cluster, "--services", serviceName])
  .services?.[0];
if (!service || service.status !== "ACTIVE" || !service.taskDefinition) {
  throw new Error("The ECS API service is missing or inactive.");
}
if (service.desiredCount < 1 || service.runningCount < 1) {
  throw new Error("The ECS API service has no running task.");
}

const definition = awsJson([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  service.taskDefinition,
]).taskDefinition;
const container = definition?.containerDefinitions?.find(
  (item) => item.name === containerName,
);
const cookieSecret = container?.environment?.find(
  (item) => item.name === "AUTH_COOKIE_SECRET",
)?.value;
if (typeof cookieSecret !== "string" || cookieSecret.length < 32) {
  throw new Error("The active API task definition has no usable session secret.");
}

// O limitador da API é por IP: acima dele o gerador mede o 429, não a API. Aborta
// antes de gastar a rodada (ALLOW_RATE_LIMITED=1 ignora, para medir o limitador
// de propósito).
const rateLimitPerMinute = Number(
  container?.environment?.find((item) => item.name === "RATE_LIMIT_PER_MINUTE")?.value ?? 180,
);
const peakByMode = {
  smoke: 1,
  load: Number(rate),
  stress: Number(rate) * 2,
  spike: Number(rate) * 4,
  breakpoint: 150,
  soak: Number(rate),
};
const plannedPeak = peakByMode[mode];
if (!Number.isFinite(plannedPeak)) {
  throw new Error(`MODE inválido: ${mode}. Use ${Object.keys(peakByMode).join(", ")}.`);
}
if (plannedPeak * 60 > rateLimitPerMinute && process.env.ALLOW_RATE_LIMITED !== "1") {
  throw new Error(
    `O pico do perfil ${mode} (${plannedPeak} req/s = ${plannedPeak * 60}/min) excede ` +
      `RATE_LIMIT_PER_MINUTE=${rateLimitPerMinute} da task ativa; o k6 mediria o 429, não a API. ` +
      "Eleve o limite só na janela do teste (preset protegido loadtest-20000) ou reduza RATE.",
  );
}

let healthy = false;
let lastStatus = "no response";
for (let attempt = 0; attempt < 36; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    lastStatus = `HTTP ${response.status}`;
    if (response.status === 200) {
      healthy = true;
      break;
    }
  } catch (error) {
    lastStatus = error instanceof Error ? error.name : "network error";
  }
  await delay(10_000);
}
if (!healthy) throw new Error(`The API health endpoint did not become ready (${lastStatus}).`);

command("k6", ["version"]);
mkdirSync(resultsDir, { recursive: true });
const env = {
  ...process.env,
  BASE_URL: baseUrl,
  AUTH_COOKIE_SECRET: cookieSecret,
  MODE: mode,
  RATE: rate,
  INCIDENT_COUNT: process.env.INCIDENT_COUNT || "300",
  RESULTS_DIR: resultsDir,
};
if (duration) env.DURATION = duration;

console.log(
  `AWS account verified: ${account}; target: ${target}; API health: HTTP 200; mode: ${mode}; ` +
    `planned peak: ${plannedPeak} req/s (limit ${rateLimitPerMinute}/min).`,
);
const args = ["run"];
for (const name of ["BASE_URL", "MODE", "RATE", "INCIDENT_COUNT", "RESULTS_DIR"]) {
  args.push("-e", `${name}=${env[name]}`);
}
if (duration) args.push("-e", `DURATION=${duration}`);
args.push("front-api.js");
command("k6", args, { cwd: path.join(loadtestDir, "k6"), env, stdio: "inherit" });

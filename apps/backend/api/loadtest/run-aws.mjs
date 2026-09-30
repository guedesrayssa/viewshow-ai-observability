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

const baseUrl = terraformOutput("api_url_https").replace(/\/$/, "");
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

console.log(`AWS account verified: ${account}; API health: HTTP 200; mode: ${mode}.`);
const args = ["run"];
for (const name of ["BASE_URL", "MODE", "RATE", "INCIDENT_COUNT", "RESULTS_DIR"]) {
  args.push("-e", `${name}=${env[name]}`);
}
if (duration) args.push("-e", `DURATION=${duration}`);
args.push("front-api.js");
command("k6", args, { cwd: path.join(loadtestDir, "k6"), env, stdio: "inherit" });

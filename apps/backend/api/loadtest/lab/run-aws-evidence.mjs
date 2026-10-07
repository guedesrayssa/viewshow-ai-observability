#!/usr/bin/env node
import { processingBudgetSeconds } from "./capacity-contract.mjs";
// Execute the current scenario against an explicitly identified existing stack.
// The session secret is read only into child-process memory and never saved.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const lab = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(lab, "../..");
const region = process.env.AWS_REGION || "us-east-1";
const stateDir = process.env.TF_DIR;
const expected = process.env.EXPECTED_AWS_ACCOUNT_ID;
if (!stateDir || !/^\d{12}$/.test(expected || ""))
  throw Error("TF_DIR and EXPECTED_AWS_ACCOUNT_ID are required");
function command(name, args) {
  const r = spawnSync(name, args, { encoding: "utf8" });
  if (r.status !== 0) throw Error(`${name} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function aws(args) {
  return JSON.parse(
    command("aws", [...args, "--region", region, "--output", "json"]),
  );
}
const account = aws(["sts", "get-caller-identity"]).Account;
if (account !== expected) throw Error("AWS account mismatch");
const url = command("terraform", [
  `-chdir=${stateDir}`,
  "output",
  "-raw",
  "api_url_https",
]).replace(/\/$/, "");
const service = aws([
  "ecs",
  "describe-services",
  "--cluster",
  "view-show-iac-cluster",
  "--services",
  "view-show-iac-api-service",
]).services[0];
const definition = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  service.taskDefinition,
]).taskDefinition;
const container = definition.containerDefinitions.find(
  (c) => c.name === "view-show-iac-api",
);
const cookieSecret = container.environment.find(
  (e) => e.name === "AUTH_COOKIE_SECRET",
)?.value;
if (!cookieSecret || cookieSecret.length < 32)
  throw Error("No usable API session secret");
const out = path.resolve(process.env.RESULTS_DIR || "results/aws-evidence");
mkdirSync(out, { recursive: true });
const ingestion = process.env.SCENARIO !== "api";
const mode = process.env.MODE || (ingestion ? "drenagem" : "smoke");
const runLabel = process.env.RUN_LABEL || mode;
const processingBudget =
  ingestion && mode === "drenagem"
    ? processingBudgetSeconds(
        process.env.EXPECTED_EVENTS,
        process.env.WINDOW_SECONDS,
      )
    : null;
const started = new Date().toISOString();
const metadata = {
  account,
  region,
  startedAt: started,
  baseUrl: url,
  taskDefinition: service.taskDefinition,
  apiImage: container.image,
  cpu: definition.cpu,
  memory: definition.memory,
  scenario: ingestion ? "ingestao-batch.js" : "front-api.js",
  mode,
  runLabel,
  auth: "signed session prepared in memory; Cognito login excluded",
  plannedRate: process.env.RATE || null,
  expectedEvents: process.env.EXPECTED_EVENTS || null,
  processingBudgetSeconds: processingBudget,
  codeRevision: command("git", ["-C", api, "rev-parse", "HEAD"]),
};
writeFileSync(
  path.join(out, "metadata.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
const child = spawn(
  "k6",
  ["run", path.resolve(api, `loadtest/k6/${metadata.scenario}`)],
  {
    cwd: out,
    env: {
      ...process.env,
      AUTH_COOKIE_SECRET: cookieSecret,
      BASE_URL: url,
      RESULTS_DIR: out,
      MODE: mode,
      RUN_LABEL: runLabel,
      ...(processingBudget === null
        ? {}
        : { WINDOW_SECONDS: String(processingBudget) }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
child.on("exit", (code, signal) => {
  metadata.finishedAt = new Date().toISOString();
  metadata.exitCode = code;
  metadata.signal = signal;
  writeFileSync(
    path.join(out, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

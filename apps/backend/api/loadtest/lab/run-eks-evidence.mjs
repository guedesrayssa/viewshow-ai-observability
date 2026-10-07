// Run the current k6 scenario against the owned native EKS deployment.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processingBudgetSeconds } from "./capacity-contract.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const evidence = path.join(
  root,
  "assets/testes-carga/2026-10-06-fechamento-aws/eks-native",
);
function command(program, args) {
  const r = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw Error(`${program} command failed`);
  return r.stdout.trim();
}
const resources = JSON.parse(
  readFileSync(path.join(evidence, "resources.json")),
);
const edge = JSON.parse(readFileSync(path.join(evidence, "edge.json")));
const images = JSON.parse(readFileSync(path.join(evidence, "images.json")));
const identity = JSON.parse(
  command("aws", ["sts", "get-caller-identity", "--output", "json"]),
);
if (identity.Account !== resources.account) throw Error("AWS account mismatch");
const cluster = command("kubectl", [
  "config",
  "view",
  "--minify",
  "-o",
  "jsonpath={.contexts[0].context.cluster}",
]);
if (
  cluster !==
  `arn:aws:eks:${resources.region}:${resources.account}:cluster/${resources.cluster}`
)
  throw Error("EKS context mismatch");
const encoded = command("kubectl", [
  "-n",
  resources.namespace,
  "get",
  "secret",
  "api-env",
  "-o",
  "jsonpath={.data.AUTH_COOKIE_SECRET}",
]);
const secret = Buffer.from(encoded, "base64").toString();
if (secret.length < 32) throw Error("Invalid session secret");
const ingestion = process.env.SCENARIO !== "api";
const mode = process.env.MODE || (ingestion ? "smoke" : "smoke");
const runLabel = process.env.RUN_LABEL || mode;
const out = path.resolve(process.env.RESULTS_DIR);
mkdirSync(out, { recursive: true });
const budget =
  ingestion && mode === "drenagem"
    ? processingBudgetSeconds(
        process.env.EXPECTED_EVENTS,
        process.env.WINDOW_SECONDS,
      )
    : null;
const scenario = ingestion ? "ingestao-batch.js" : "front-api.js";
const meta = {
  startedAt: new Date().toISOString(),
  account: resources.account,
  region: resources.region,
  cluster: resources.cluster,
  namespace: resources.namespace,
  importsNamespace: resources.importsNamespace,
  baseUrl: edge.baseUrl,
  networkScope: edge.networkScope,
  mode,
  runLabel,
  scenario,
  processingBudgetSeconds: budget,
  expectedEvents: process.env.EXPECTED_EVENTS || null,
  plannedRate: process.env.RATE || null,
  codeRevision: command("git", ["-C", root, "rev-parse", "HEAD"]),
  images,
  auth: "synthetic signed session; Cognito login excluded",
  activation: "runner does not activate candidate",
};
writeFileSync(
  path.join(out, "metadata.json"),
  JSON.stringify(meta, null, 2) + "\n",
);
const child = spawn(
  "k6",
  ["run", path.join(root, "apps/backend/api/loadtest/k6", scenario)],
  {
    cwd: out,
    env: {
      ...process.env,
      BASE_URL: edge.baseUrl,
      AUTH_COOKIE_SECRET: secret,
      RESULTS_DIR: out,
      RUN_LABEL: runLabel,
      MODE: mode,
      ...(budget === null ? {} : { WINDOW_SECONDS: String(budget) }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
child.on("exit", (code, signal) => {
  Object.assign(meta, {
    finishedAt: new Date().toISOString(),
    exitCode: code,
    signal,
  });
  writeFileSync(
    path.join(out, "metadata.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

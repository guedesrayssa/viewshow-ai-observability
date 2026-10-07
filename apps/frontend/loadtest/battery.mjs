/** Repeats nominal load after the spike, without a sleep or server restart between profiles. */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./static-contract.mjs";

const output = path.resolve(process.env.RESULTS_DIR || "loadtest/results");
const exportDir = path.resolve(process.env.OUT_DIR || "out");
const serverPid = process.env.SERVER_PID ? Number(process.env.SERVER_PID) : null;
if (serverPid !== null && (!Number.isSafeInteger(serverPid) || serverPid < 1)) throw new Error("SERVER_PID inválido");
await mkdir(output, { recursive: true });
const files = [];
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(file);
    else {
      const bytes = await readFile(file);
      files.push({ path: path.relative(exportDir, file).split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
}
await visit(exportDir);
files.sort((a, b) => a.path.localeCompare(b.path));
const environment = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  nodeVersion: process.version, platform: os.platform(), cpu: os.cpus()[0].model,
  memoryBytes: os.totalmem(), serverPid, serverLivenessChecks: [],
  build: { fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), sha256: sha256(JSON.stringify(files)), files },
  runs: [],
};
for (const [profile, label] of [["smoke", "smoke"], ["load", "load"], ["spike", "spike"], ["load", "load-recovery"]]) {
  if (serverPid) { process.kill(serverPid, 0); environment.serverLivenessChecks.push({ label, before: new Date().toISOString(), pid: serverPid }); }
  const scheduledAt = new Date().toISOString();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./static.mjs", import.meta.url))], {
      env: { ...process.env, PROFILE: profile, RUN_LABEL: label, RESULTS_DIR: output, OUT_DIR: exportDir },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (serverPid) process.kill(serverPid, 0);
  const result = JSON.parse(await readFile(path.join(output, `static-${label}.json`), "utf8"));
  environment.runs.push({ profile, label, scheduledAt, exitCode, startedAt: result.startedAt, finishedAt: result.finishedAt, thresholds: result.thresholds });
  await writeFile(path.join(output, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
  console.log(`${label}: exit=${exitCode}, p97.5=${result.results?.latency.p97_5} ms, req/s=${result.results?.requests.average}, contentErrors=${result.results?.contentErrors}`);
  if (exitCode !== 0) process.exitCode = 1;
  if (result.preflightError) throw new Error(result.preflightError);
}

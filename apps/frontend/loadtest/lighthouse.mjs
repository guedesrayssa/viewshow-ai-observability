/** Runs each audit in its own Chrome process, awaiting exit before starting the next. */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { sha256 } from "./static-contract.mjs";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("lighthouse/package.json")), "cli/index.js");
const target = new URL(process.env.LIGHTHOUSE_URL || "http://127.0.0.1:4173/login/");
const output = path.resolve(process.env.RESULTS_DIR || "loadtest/results");
const repetitions = Number(process.env.REPETITIONS || 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("REPETITIONS deve ser inteiro positivo.");
await mkdir(output, { recursive: true });
const runs = [];
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
for (const profile of ["desktop", "mobile"]) {
  for (let index = 1; index <= repetitions; index += 1) {
    const filename = `lighthouse-${profile}-${index}.json`;
    const args = [cli, target.href, "--only-categories=performance", "--output=json",
      `--output-path=${path.join(output, filename)}`, "--chrome-flags=--headless=new", "--quiet"];
    if (profile === "desktop") args.push("--preset=desktop");
    const startedAt = new Date().toISOString();
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Lighthouse ${filename} terminou com ${code}`)));
    });
    const finishedAt = new Date().toISOString();
    const bytes = await readFile(path.join(output, filename));
    const report = JSON.parse(bytes);
    if (report.runtimeError) throw new Error(JSON.stringify(report.runtimeError));
    runs.push({ profile, index, startedAt, finishedAt, command: [process.execPath, ...args],
      file: filename, sha256: sha256(bytes), lighthouseVersion: report.lighthouseVersion,
      benchmarkIndex: report.environment.benchmarkIndex, warnings: report.runWarnings });
    console.log(`${filename}: FCP=${Math.round(report.audits["first-contentful-paint"].numericValue)} ms, LCP=${Math.round(report.audits["largest-contentful-paint"].numericValue)} ms`);
    await writeFile(path.join(output, "lighthouse-executions.json"), JSON.stringify({ target: target.href, revision, sequential: true, runs }, null, 2) + "\n");
  }
}

/** Runs each audit in its own Chrome process, awaiting exit before starting the next. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { launch } from "chrome-launcher";
import { sha256 } from "./static-contract.mjs";
import { validateLighthouseReport } from "./lighthouse-contract.mjs";

const target = new URL(process.env.LIGHTHOUSE_URL || "http://127.0.0.1:4173/login/");
const output = path.resolve(process.env.RESULTS_DIR || "loadtest/results");
const repetitions = Number(process.env.REPETITIONS || 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("REPETITIONS deve ser inteiro positivo.");
await mkdir(output, { recursive: true });
const runs = [];
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
for (const profile of ["desktop", "mobile"]) {
  for (let index = 1; index <= repetitions; index += 1) {
    const filename = `lighthouse-${profile}-${index}.json`;
    const startedAt = new Date().toISOString();
    // A concrete free port avoids relying on the browser's stderr format to discover port 0.
    const chrome = await launch({ port: await availablePort(), chromePath: process.env.CHROME_PATH,
      chromeFlags: ["--headless=new"], logLevel: "silent" });
    let result;
    try {
      result = await lighthouse(target.href, { port: chrome.port, onlyCategories: ["performance"],
        output: "json", logLevel: "error" }, profile === "desktop" ? desktopConfig : undefined);
      await writeFile(path.join(output, filename), result.report);
    } finally {
      await chrome.kill();
    }
    const finishedAt = new Date().toISOString();
    const bytes = await readFile(path.join(output, filename));
    const report = JSON.parse(bytes);
    validateLighthouseReport(report);
    runs.push({ profile, index, startedAt, finishedAt,
      command: [process.execPath, process.argv[1]], chromePath: process.env.CHROME_PATH || "auto",
      settings: report.configSettings,
      file: filename, sha256: sha256(bytes), lighthouseVersion: report.lighthouseVersion,
      benchmarkIndex: report.environment.benchmarkIndex, warnings: report.runWarnings });
    console.log(`${filename}: FCP=${Math.round(report.audits["first-contentful-paint"].numericValue)} ms, LCP=${Math.round(report.audits["largest-contentful-paint"].numericValue)} ms`);
    await writeFile(path.join(output, "lighthouse-executions.json"), JSON.stringify({ target: target.href, revision, sequential: true, runs }, null, 2) + "\n");
  }
}

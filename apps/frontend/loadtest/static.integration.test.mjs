import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the real CLI and Autocannon against a disposable server; no external service is called. */
async function exercise(t, failureDuringLoad) {
  const output = await mkdtemp(path.join(tmpdir(), "front-static-contract-"));
  const html = '<!doctype html><html><script src="/_next/static/chunk.js"></script></html>';
  let assetRequests = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/_next/static/")) {
      assetRequests += 1;
      const valid = failureDuringLoad && assetRequests === 1;
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(valid ? "console.log(1);" : html);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(output, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, PROFILE: "smoke", RUN_LABEL: "negative-control", RESULTS_DIR: output };
  delete env.OUT_DIR;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./static.mjs", import.meta.url))], { env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { exit: result, summary: JSON.parse(await readFile(path.join(output, "static-negative-control.json"), "utf8")) };
}

test("the real preflight rejects a 200 HTML fallback with a forged JS Content-Type", async (t) => {
  const result = await exercise(t, false);
  assert.equal(result.exit, 1);
  assert.match(result.summary.preflightError, /HTML fallback/);
});

test("the real load test rejects assets that become invalid after preflight", async (t) => {
  const result = await exercise(t, true);
  assert.equal(result.exit, 1);
  assert.ok(result.summary.results.contentErrors > 0);
  assert.equal(result.summary.thresholds.noHttpErrors, true);
  assert.equal(result.summary.thresholds.validContent, false);
});

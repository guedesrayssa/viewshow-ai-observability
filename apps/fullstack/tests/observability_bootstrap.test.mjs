import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(
  testDirectory,
  "..",
  "observability",
  "aws",
  "validate-user-data.sh",
);

test("standalone renderer embeds the ingestion dashboard in gzip EC2 user data", () => {
  const workDirectory = mkdtempSync(path.join(tmpdir(), "view-show-observability-test-"));
  try {
    const output = path.join(workDirectory, "user-data.sh");
    const result = spawnSync("sh", [script, output], {
      encoding: "utf8",
      env: {
        ...process.env,
        RENDER_AWS_ACCOUNT_ID: "123456789012",
        RENDER_AWS_REGION: "us-east-1",
        RENDER_GRAFANA_PASSWORD: "test-password-not-deployed",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const plain = readFileSync(output);
    const compressedPath = `${output}.gz`;
    const compressed = readFileSync(compressedPath);
    assert.ok(statSync(compressedPath).size <= 16_384);
    assert.deepEqual(gunzipSync(compressed), plain);

    const shell = plain.toString("utf8");
    assert.match(shell, /view-show-ingestion\.json/);
    assert.doesNotMatch(shell, /\$\{ingestion_dashboard_gzip\}/);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
});

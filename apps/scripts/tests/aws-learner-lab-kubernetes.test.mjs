import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const script = fileURLToPath(
  new URL("../aws-learner-lab-kubernetes.mjs", import.meta.url),
);
test("Kubernetes help identifies the legacy launcher without external calls", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "kubernetes-legacy-help-"));
  const calls = path.join(directory, "calls");
  try {
    for (const program of ["terraform", "aws", "kubectl", "helm"]) {
      writeFileSync(path.join(directory, program), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$LEGACY_CALL_LOG"\nexit 1\n', { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [script, "help"], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, LEGACY_CALL_LOG: calls },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /launcher Kubernetes legado/i);
    assert.match(result.stdout, /check \| plan \| deploy \| evidence/);
    assert.equal(readdirSync(directory).includes("calls"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("legacy Kubernetes check warns and still runs its four existing commands", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "kubernetes-legacy-cli-"));
  const calls = path.join(directory, "calls");
  try {
    for (const program of ["terraform", "aws", "kubectl", "helm"]) {
      writeFileSync(path.join(directory, program), `#!/bin/sh\nprintf "${program} %s\\n" "$*" >> "$LEGACY_CALL_LOG"\n`, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [script, "check"], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, LEGACY_CALL_LOG: calls },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      "terraform version",
      "aws sts get-caller-identity",
      "kubectl version --client",
      "helm version",
    ]);
    assert.match(result.stderr, /launcher Kubernetes legado/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("retired commands fail without touching the cloud", () => {
  for (const command of ["seed", "destroy", "all", "update", "import-canary"]) {
    const result = spawnSync(process.execPath, [script, command], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Comando ECS retirado/);
  }
});

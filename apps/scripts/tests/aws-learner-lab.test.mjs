import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("../aws-learner-lab.mjs", import.meta.url),
);
test("retired commands fail without touching the cloud", () => {
  for (const command of ["seed", "destroy", "all", "update", "import-canary"]) {
    const result = spawnSync(process.execPath, [script, command], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Comando ECS retirado/);
  }
});

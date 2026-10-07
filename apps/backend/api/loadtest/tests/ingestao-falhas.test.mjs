import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../k6/ingestao-falhas.sh", import.meta.url));

/** A fake CLI confines policy operations to a temporary directory. */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingestion-policy-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "aws"), `#!/bin/sh
case "$2" in
  get-bucket-policy) printf '%s\\n' "An error occurred ($FAKE_ERROR)" >&2; exit 254 ;;
  put-bucket-policy|delete-bucket-policy) printf '%s\\n' "$2" >> "$FAKE_CALLS" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const prefix = path.join(dir, "state");
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, ESTADO_FALHAS: prefix, FAKE_CALLS: path.join(dir, "calls"), RUNBOOK: JSON.stringify({ storage: { bucket: "bucket-a" } }) };
  return { dir, prefix, env, run: (command, changes = {}) => spawnSync("bash", [script, command], { env: { ...env, ...changes }, encoding: "utf8" }) };
}

test("an unreadable bucket policy is never treated as a nonexistent policy", (t) => {
  const f = fixture(t);
  const result = f.run("s3-negar", { FAKE_ERROR: "AccessDenied" });
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(f.dir, "calls")), false);
  assert.equal(fs.existsSync(f.prefix + ".politica-original.json"), false);
});

test("a saved policy cannot be injected or restored against another bucket", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.prefix + ".politica-original.json", '{"Version":"2012-10-17","Statement":[]}');
  fs.writeFileSync(f.prefix + ".bucket", "bucket-b\n");
  for (const command of ["s3-negar", "s3-restaurar"]) {
    assert.equal(f.run(command).status, 2);
  }
  assert.equal(fs.existsSync(path.join(f.dir, "calls")), false);
});

test("NoSuchBucketPolicy can be injected and restored only on its original bucket", (t) => {
  const f = fixture(t);
  assert.equal(f.run("s3-negar", { FAKE_ERROR: "NoSuchBucketPolicy" }).status, 0);
  const policy = JSON.parse(fs.readFileSync(f.prefix + ".politica-negada.json", "utf8"));
  assert.equal(policy.Statement[0].Resource, "arn:aws:s3:::bucket-a/staging/imports/*");
  assert.equal(f.run("s3-restaurar").status, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, "calls"), "utf8"), "put-bucket-policy\ndelete-bucket-policy\n");
  assert.equal(fs.existsSync(f.prefix + ".politica-original.json"), false);
});

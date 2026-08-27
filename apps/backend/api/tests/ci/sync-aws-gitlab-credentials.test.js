const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/sync-aws-gitlab-credentials.sh");

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runSynchronizer({ account = "248880318395", dryRun = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "credential-sync-"));
  const bin = path.join(directory, "bin");
  const callLog = path.join(directory, "calls.log");
  fs.mkdirSync(bin);

  writeExecutable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws:%s\\n' "$*" >>"$CALL_LOG"
case "$*" in
  *"configure export-credentials"*) printf '%s\\n' '{"Version":1,"AccessKeyId":"TESTACCESS","SecretAccessKey":"TESTSECRET","SessionToken":"TESTSESSION"}' ;;
  *"sts get-caller-identity"*) printf '%s\\n' "$FAKE_ACCOUNT" ;;
  *"ecr describe-repositories"*) printf '%s\\n' 'monitoracao-api' ;;
  *"ecs describe-services"*) printf '%s\\n' 'ACTIVE' ;;
  *) exit 2 ;;
esac
`,
  );

  writeExecutable(
    path.join(bin, "glab"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth status" ]]; then
  printf '%s\\n' 'auth status noisy' >&2
  exit 0
fi
if [[ "$1 $2" == "variable set" ]]; then
  value="$(cat)"
  printf 'glab:set:%s:%s\\n' "$3" "$*" >>"$CALL_LOG"
  exit 0
fi
exit 2
`,
  );

  const result = spawnSync(script, dryRun ? ["--dry-run"] : [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: callLog,
      FAKE_ACCOUNT: account,
    },
  });

  return {
    result,
    calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "",
  };
}

test("dry-run validates AWS but does not mutate GitLab variables", () => {
  const { result, calls } = runSynchronizer({ dryRun: true });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(calls, /glab:set:/);
  assert.match(result.stdout, /dry-run validated/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /auth status noisy/);
});

test("synchronizer rejects an unexpected AWS account", () => {
  const { result, calls } = runSynchronizer({ account: "000000000000" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS account/);
  assert.doesNotMatch(calls, /glab:set:/);
});

test("synchronizer updates only the three protected AWS variables", () => {
  const { result, calls } = runSynchronizer();
  assert.equal(result.status, 0, result.stderr);
  const updates = calls.split("\n").filter((line) => line.startsWith("glab:set:"));
  assert.deepEqual(
    updates.map((line) => line.split(":")[2]),
    ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  );
  for (const update of updates) {
    assert.match(update, /--protected/);
    assert.match(update, /--masked/);
    assert.match(update, /--hidden/);
    assert.match(update, /--raw/);
  }
  assert.doesNotMatch(`${result.stdout}${result.stderr}${calls}`, /TESTSECRET|TESTSESSION/);
});

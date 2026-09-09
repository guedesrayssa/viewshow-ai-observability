const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/ci/smoke-container.sh");
const image = "monitoracao-api:test";

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runSmoke({
  healthBody = '{"status":"ok"}',
  architecture = "amd64",
  user = "node",
  hangHealthBody = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-smoke-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const nameFile = path.join(directory, "name.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  writeExecutable(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'docker:%s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "image inspect $EXPECTED_IMAGE --format {{.Architecture}}" ]]; then
  printf '%s\n' "$ARCHITECTURE"
elif [[ "$1" == "run" && "$2" == "--detach" && "$3" == "--name" && "$5" == "--env" && "$6" == "NODE_ENV=test" && "$7" == "--env" && "$8" == "AUTH_COOKIE_SECRET=ci-smoke-cookie-secret-at-least-32-bytes" && "$9" == "--env" && "\${10}" == "CURSOR_SECRET=ci-smoke-cursor-secret-at-least-32-bytes" && "\${11}" == "$EXPECTED_IMAGE" && "$#" == "11" ]]; then
  printf '%s' "$4" >"$NAME_FILE"
  echo fixture-container-id
elif [[ "$1" == "inspect" && "$2" == "--format" && "$3" == "{{.State.Health.Status}}" && "$4" == "$(cat "$NAME_FILE")" ]]; then
  echo healthy
elif [[ "$1" == "inspect" && "$2" == "--format" && "$3" == "{{.Config.User}}" && "$4" == "$(cat "$NAME_FILE")" ]]; then
  printf '%s\n' "$CONFIGURED_USER"
elif [[ "$1" == "exec" && "$2" == "$(cat "$NAME_FILE")" && "$3" == "node" && "$4" == "-e" && "$#" == "5" ]]; then
  if [[ "$5" == *"/health"* && "$5" == *"signal:AbortSignal.timeout(5000)"* ]]; then
    if [[ "$HANG_HEALTH_BODY" == "true" ]]; then exit 28; fi
    printf '%s' "$HEALTH_BODY"
  elif [[ "$5" == *"/auth/login"* && "$5" == *"signal:AbortSignal.timeout(5000)"* ]]; then
    printf '%s' '{"status":503,"body":{"error":{"code":"FEATURE_UNAVAILABLE","requestId":"req_test"}}}'
  elif [[ "$HANG_HEALTH_BODY" == "true" ]]; then
    sleep 1
    printf '%s' "$HEALTH_BODY"
  else
    echo "docker exec health probe has no abort deadline" >&2
    exit 2
  fi
elif [[ "$1" == "rm" && "$2" == "-f" && "$3" == "$(cat "$NAME_FILE")" && "$#" == "3" ]]; then
  :
else
  echo "unexpected docker call: $*" >&2
  exit 2
fi
`,
  );

  const result = spawnSync(script, [image], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      NAME_FILE: nameFile,
      EXPECTED_IMAGE: image,
      ARCHITECTURE: architecture,
      CONFIGURED_USER: user,
      HEALTH_BODY: healthBody,
      HANG_HEALTH_BODY: String(hangHealthBody),
      SMOKE_ATTEMPTS: "1",
      SMOKE_DELAY_SECONDS: "0",
    },
  });
  const execution = { result, calls: fs.readFileSync(calls, "utf8") };
  fs.rmSync(directory, { recursive: true });
  return execution;
}

test("container smoke accepts health and a fail-closed federated login", () => {
  const { result, calls } = runSmoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /container health check passed/);
  assert.match(
    calls,
    /--env NODE_ENV=test --env AUTH_COOKIE_SECRET=.* --env CURSOR_SECRET=/,
  );
  assert.match(calls, /\/auth\/login/);
  assert.match(calls, /docker:rm -f/);
});

test("container smoke aborts a hanging response body", () => {
  const startedAt = Date.now();
  const { result, calls } = runSmoke({ hangHealthBody: true });
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.ok(elapsedMilliseconds < 500, `hanging body took ${elapsedMilliseconds}ms`);
  assert.match(calls, /docker:rm -f/);
});

for (const healthBody of [
  '{"status":"bad"}\n{"status":"ok"}',
  '{"status":"ok"}{"status":"ok"}',
  '{"status":"ok","extra":true}',
]) {
  test(`container smoke rejects non-exact document stream ${JSON.stringify(healthBody)}`, () => {
    const { result, calls } = runSmoke({ healthBody });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected health payload/);
    assert.match(calls, /docker:rm -f/);
  });
}

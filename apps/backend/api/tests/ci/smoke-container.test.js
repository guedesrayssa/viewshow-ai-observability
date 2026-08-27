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

function runSmoke({ healthBody = '{"status":"ok"}', architecture = "amd64", user = "node" } = {}) {
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
elif [[ "$1" == "run" && "$2" == "--detach" && "$3" == "--name" && "$5" == "$EXPECTED_IMAGE" && "$#" == "5" ]]; then
  printf '%s' "$4" >"$NAME_FILE"
  echo fixture-container-id
elif [[ "$1" == "inspect" && "$2" == "--format" && "$3" == "{{.State.Health.Status}}" && "$4" == "$(cat "$NAME_FILE")" ]]; then
  echo healthy
elif [[ "$1" == "inspect" && "$2" == "--format" && "$3" == "{{.Config.User}}" && "$4" == "$(cat "$NAME_FILE")" ]]; then
  printf '%s\n' "$CONFIGURED_USER"
elif [[ "$1" == "exec" && "$2" == "$(cat "$NAME_FILE")" && "$3" == "node" && "$4" == "-e" && "$#" == "5" ]]; then
  printf '%s' "$HEALTH_BODY"
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
      SMOKE_ATTEMPTS: "1",
      SMOKE_DELAY_SECONDS: "0",
    },
  });
  const execution = { result, calls: fs.readFileSync(calls, "utf8") };
  fs.rmSync(directory, { recursive: true });
  return execution;
}

test("container smoke accepts exactly one expected health JSON document", () => {
  const { result, calls } = runSmoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /container health check passed/);
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

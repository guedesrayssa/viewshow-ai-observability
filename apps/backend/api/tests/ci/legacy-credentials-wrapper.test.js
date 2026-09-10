const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const legacyScript = path.join(
  repoRoot,
  "apps/frontend/deploy/credenciais-gitlab.sh",
);
const historicalBackendGuide = fs.readFileSync(
  path.join(repoRoot, "artefatos/sprint2/backend-sprint-2.md"),
  "utf8",
);

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function prepareIsolatedWrapper() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-wrapper-"));
  const copiedWrapper = path.join(
    directory,
    "repo/apps/frontend/deploy/credenciais-gitlab.sh",
  );
  const hardenedSynchronizer = path.join(
    directory,
    "repo/scripts/sync-aws-gitlab-credentials.sh",
  );
  const unrelatedWorkingDirectory = path.join(directory, "elsewhere");
  const argumentLog = path.join(directory, "arguments.log");
  const invocationLog = path.join(directory, "invocation.log");

  fs.mkdirSync(path.dirname(copiedWrapper), { recursive: true });
  fs.mkdirSync(path.dirname(hardenedSynchronizer), { recursive: true });
  fs.mkdirSync(unrelatedWorkingDirectory);
  fs.copyFileSync(legacyScript, copiedWrapper);
  fs.chmodSync(copiedWrapper, 0o755);
  writeExecutable(
    hardenedSynchronizer,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'invoked\n' >"$INVOCATION_LOG"
printf '%s\n' "$@" >"$ARGUMENT_LOG"
cat >/dev/null
`,
  );

  return {
    argumentLog,
    copiedWrapper,
    invocationLog,
    unrelatedWorkingDirectory,
  };
}

test("legacy entrypoint contains no direct GitLab write or credential handling", () => {
  const source = fs.readFileSync(legacyScript, "utf8");

  assert.notEqual(fs.statSync(legacyScript).mode & 0o111, 0);
  assert.match(source, /sync-aws-gitlab-credentials\.sh/);
  assert.doesNotMatch(
    source,
    /\b(?:curl|glab)\b|PRIVATE-TOKEN|\/variables(?:\/|\b)/,
  );
  assert.doesNotMatch(
    source,
    /GITLAB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/,
  );
  assert.doesNotMatch(
    source,
    /environment_scope|--scope\s+["']?\*|protected=false/,
  );
});

test("legacy entrypoint forwards only supported options through its absolute target", () => {
  const fixture = prepareIsolatedWrapper();
  const input = [
    "[default]",
    "aws_access_key_id=fixture-access",
    "aws_secret_access_key=fixture-secret",
    "aws_session_token=fixture-session",
    "",
  ].join("\n");
  const result = spawnSync(
    fixture.copiedWrapper,
    ["--allow-unprotected-develop", "--dry-run"],
    {
      cwd: fixture.unrelatedWorkingDirectory,
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        ARGUMENT_LOG: fixture.argumentLog,
        INVOCATION_LOG: fixture.invocationLog,
        GITLAB_TOKEN: "fixture-token",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fixture.invocationLog, "utf8"), "invoked\n");
  assert.equal(
    fs.readFileSync(fixture.argumentLog, "utf8"),
    "--allow-unprotected-develop\n--dry-run\n",
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}${fs.readFileSync(fixture.argumentLog, "utf8")}`,
    /fixture-(?:access|secret|session|token)/,
  );
});

test("legacy entrypoint rejects credential arguments before invoking any client", () => {
  const fixture = prepareIsolatedWrapper();
  const bin = path.join(path.dirname(fixture.copiedWrapper), "fake-bin");
  const directClientLog = path.join(
    path.dirname(fixture.argumentLog),
    "client.log",
  );
  fs.mkdirSync(bin);
  for (const command of ["curl", "glab"]) {
    writeExecutable(
      path.join(bin, command),
      `#!/usr/bin/env bash
printf '%s:%s\n' '${command}' "$*" >>"$DIRECT_CLIENT_LOG"
printf '200'
`,
    );
  }

  const result = spawnSync(fixture.copiedWrapper, ["fixture-secret-argument"], {
    cwd: fixture.unrelatedWorkingDirectory,
    encoding: "utf8",
    input:
      "aws_access_key_id=fixture-access\n" +
      "aws_secret_access_key=fixture-secret\n" +
      "aws_session_token=fixture-session\n",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ARGUMENT_LOG: fixture.argumentLog,
      INVOCATION_LOG: fixture.invocationLog,
      DIRECT_CLIENT_LOG: directClientLog,
      GITLAB_PROJECT_ID: "42",
      GITLAB_TOKEN: "fixture-token",
    },
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage:/);
  assert.equal(fs.existsSync(fixture.invocationLog), false);
  assert.equal(fs.existsSync(directClientLog), false);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /fixture-(?:secret|token)/,
  );
});

test("historical backend guide points to the hardened flow and deprecated wrapper", () => {
  assert.match(
    historicalBackendGuide,
    /scripts\/sync-aws-gitlab-credentials\.sh/,
  );
  assert.match(
    historicalBackendGuide,
    /apps\/frontend\/deploy\/credenciais-gitlab\.sh[^\n]*descontinuado/i,
  );
  assert.match(historicalBackendGuide, /escopo `aws-lab`/);
  assert.doesNotMatch(
    historicalBackendGuide,
    /GITLAB_TOKEN|pbpaste|wl-paste|colar[^\n]*credencia/i,
  );
});

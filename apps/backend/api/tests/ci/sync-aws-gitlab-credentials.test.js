const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/sync-aws-gitlab-credentials.sh");
const canonicalRepository = "https://git.inteli.edu.br/group/project";
const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function metadata(entries, ndjson = false) {
  const records = entries.map(([key, environment_scope = "*", hidden = true, overrides = {}]) => ({
      key,
      environment_scope,
      hidden,
      protected: true,
      masked: true,
      raw: true,
      variable_type: "env_var",
      value: "metadata-value-must-not-leak",
      ...overrides,
    }));
  return ndjson ? records.map(JSON.stringify).join("\n") : JSON.stringify(records);
}

function runSynchronizer({
  account = "248880318395",
  callerArn = "arn:aws:sts::248880318395:assumed-role/voclabs/test-session",
  ecrResult = "monitoracao-api",
  ecsResult = "ACTIVE\t0",
  variableMetadata = "[]",
  failWriteAttempt = 0,
  origin = "https://git.inteli.edu.br/group/project.git",
  repositoryView = JSON.stringify({
    id: 42,
    web_url: canonicalRepository,
    path_with_namespace: "group/project",
  }),
  dryRun = false,
  configuredEndpoint = "",
  configuredServices = "",
  postWriteMetadata = metadata(keys.map((key) => [key, "aws-lab"])),
  envOverrides = {},
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "credential-sync-"));
  const bin = path.join(directory, "bin");
  const callLog = path.join(directory, "calls.log");
  const state = path.join(directory, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);

  writeExecutable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${AWS_PAGER+x}:\${AWS_PAGER:-}" == "x:" ]] || { echo "pager-not-disabled" >&2; exit 91; }
[[ "\${AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:-}" == "true" ]] || { echo "endpoints-not-disabled" >&2; exit 92; }
printf 'aws:%s\\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "configure get endpoint_url --profile default" ]]; then
  printf '%s\\n' "$CONFIGURED_ENDPOINT"
elif [[ "$*" == "configure get services --profile default" ]]; then
  printf '%s\\n' "$CONFIGURED_SERVICES"
elif [[ "$*" == "--profile default sts get-caller-identity --output json" ]]; then
  printf '{"Account":"%s","Arn":"%s"}\\n' "$FAKE_ACCOUNT" "$CALLER_ARN"
elif [[ "$*" == "--profile default ecr describe-repositories --region us-east-1 --repository-names monitoracao-api --query repositories[0].repositoryName --output text" ]]; then
  printf '%s\\n' "$FAKE_ECR_RESULT"
elif [[ "$*" == "--profile default ecs describe-services --region us-east-1 --cluster data-ingestion-cluster --services monitoracao-api-service --query [services[0].status, length(failures)] --output text" ]]; then
  printf '%b\\n' "$FAKE_ECS_RESULT"
elif [[ "$*" == "configure export-credentials --profile default --format process" ]]; then
  printf '%s\\n' '{"Version":1,"AccessKeyId":"fixture-access","SecretAccessKey":"fixture-secret","SessionToken":"fixture-session"}'
else
  exit 2
fi
`,
  );

  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "remote get-url origin" ]]; then
  printf 'git:origin-read\\n' >>"$CALL_LOG"
  printf '%s\\n' "$FAKE_ORIGIN"
  exit 0
fi
exit 2
`,
  );

  writeExecutable(
    path.join(bin, "glab"),
    `#!/usr/bin/env bash
set -euo pipefail
debug_ok() {
  [[ "\${GLAB_DEBUG:-}" == false && "\${GLAB_DEBUG_HTTP:-}" == false ]]
}
record_write() {
  local action="$1"
  local key="$2"
  local count_file="$STATE_DIR/write-count"
  local count=0
  [[ -f "$count_file" ]] && count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  if [[ "$count" == "$FAIL_WRITE_ATTEMPT" ]]; then
    printf 'glab:write-failed:%s:%s\\n' "$action" "$key" >>"$CALL_LOG"
    return 88
  fi
  printf 'glab:write:%s:%s:value-ok\\n' "$action" "$key" >>"$CALL_LOG"
}
debug_ok || { printf 'glab:debug-not-disabled\\n' >>"$CALL_LOG"; exit 97; }
if [[ "$1 $2" == "auth status" ]]; then
  [[ "$#" == 4 && "$3" == "--hostname" && "$4" == "git.inteli.edu.br" ]] || exit 2
  printf 'glab:auth:debug-disabled\\n' >>"$CALL_LOG"
  exit 0
fi
if [[ "$1 $2" == "repo view" ]]; then
  [[ "$#" == 5 && "$3" == "$CANONICAL_ORIGIN" && "$4" == "--output" && "$5" == "json" ]] || exit 2
  printf 'glab:repo-view:debug-disabled\\n' >>"$CALL_LOG"
  printf '%s\\n' "$REPOSITORY_VIEW"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  if [[ "$#" == 7 && "$2" == "--hostname" && "$3" == "git.inteli.edu.br" && "$4" == "--paginate" && "$5" == "--output" && "$6" == "ndjson" && "$7" == "projects/42/variables?per_page=100" ]]; then
    read_count_file="$STATE_DIR/metadata-read-count"
    read_count=0
    [[ -f "$read_count_file" ]] && read_count="$(cat "$read_count_file")"
    read_count=$((read_count + 1))
    printf '%s' "$read_count" >"$read_count_file"
    printf 'glab:api:metadata:%s:debug-disabled\\n' "$read_count" >>"$CALL_LOG"
    if [[ "$read_count" == "1" ]]; then
      printf '%s\\n' "$VARIABLE_METADATA"
    else
      printf '%s\\n' "$POST_WRITE_METADATA"
    fi
    exit 0
  fi
  if [[ "$#" == 9 && "$2" == "--hostname" && "$3" == "git.inteli.edu.br" && "$4" == "--method" && "$5" == "PUT" && "$6" == "--input" && "$7" == "-" && "$8" == "--silent" ]]; then
    endpoint="$9"
    key="\${endpoint#projects/42/variables/}"
    key="\${key%%\\?*}"
    [[ "$endpoint" == "projects/42/variables/$key?filter%5Benvironment_scope%5D=%2A" ]] || exit 2
    case "$key" in
      AWS_ACCESS_KEY_ID) expected="$FAKE_ACCESS" ;;
      AWS_SECRET_ACCESS_KEY) expected="$FAKE_SECRET" ;;
      AWS_SESSION_TOKEN) expected="$FAKE_SESSION" ;;
      *) exit 2 ;;
    esac
    body="$(cat)"
    jq -e --arg expected "$expected" '
      .value == $expected
      and .environment_scope == "aws-lab"
      and .protected == true
      and .masked == true
      and (has("hidden") | not)
      and .raw == true
      and .variable_type == "env_var"
    ' <<<"$body" >/dev/null || exit 3
    record_write migrate "$key"
    exit $?
  fi
  exit 2
fi
if [[ "$1 $2" == "variable set" || "$1 $2" == "variable update" ]]; then
  action="$2"
  key="$3"
  expected=""
  case "$key" in
    AWS_ACCESS_KEY_ID) expected="$FAKE_ACCESS" ;;
    AWS_SECRET_ACCESS_KEY) expected="$FAKE_SECRET" ;;
    AWS_SESSION_TOKEN) expected="$FAKE_SESSION" ;;
    *) exit 2 ;;
  esac
  value="$(cat)"
  [[ "$value" == "$expected" ]] || { printf 'glab:value-check-failed:%s\\n' "$key" >>"$CALL_LOG"; exit 3; }
  if [[ "$action" == set ]]; then
    [[ "$*" == "variable set $key --repo $CANONICAL_REPOSITORY --protected --masked --hidden --raw --scope aws-lab --type env_var" ]] || exit 2
  else
    [[ "$*" == "variable update $key --repo $CANONICAL_REPOSITORY --protected --masked --raw --scope aws-lab --type env_var" ]] || exit 2
  fi
  record_write "$action" "$key"
  exit $?
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
      STATE_DIR: state,
      CANONICAL_REPOSITORY: canonicalRepository,
      FAKE_ACCOUNT: account,
      CALLER_ARN: callerArn,
      FAKE_ECR_RESULT: ecrResult,
      FAKE_ECS_RESULT: ecsResult,
      CONFIGURED_ENDPOINT: configuredEndpoint,
      CONFIGURED_SERVICES: configuredServices,
      VARIABLE_METADATA: variableMetadata,
      POST_WRITE_METADATA: postWriteMetadata,
      REPOSITORY_VIEW: repositoryView,
      FAIL_WRITE_ATTEMPT: String(failWriteAttempt),
      FAKE_ACCESS: "fixture-access",
      FAKE_SECRET: "fixture-secret",
      FAKE_SESSION: "fixture-session",
      GLAB_DEBUG: "true",
      GLAB_DEBUG_HTTP: "true",
      FAKE_ORIGIN: origin,
      CANONICAL_ORIGIN: origin,
      ...envOverrides,
    },
  });

  return {
    result,
    calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "",
  };
}

function assertNoCredentialFixtureLeaks(output) {
  assert.doesNotMatch(output, /fixture-(access|secret|session)|metadata-value-must-not-leak/);
}

test("dry-run completes every preflight without writing variables or leaking credentials", () => {
  const { result, calls } = runSynchronizer({ dryRun: true });
  const output = `${result.stdout}${result.stderr}${calls}`;

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run validated/);
  assert.match(calls, /glab:auth:debug-disabled/);
  assert.match(calls, /glab:repo-view:debug-disabled/);
  assert.match(calls, /glab:api:metadata:1:debug-disabled/);
  assert.match(calls, /aws:.*ecr describe-repositories/);
  assert.match(calls, /aws:.*ecs describe-services/);
  assert.doesNotMatch(calls, /export-credentials/);
  assert.doesNotMatch(calls, /glab:write:/);
  assertNoCredentialFixtureLeaks(output);
});

test("missing target variables are created with their corresponding values", () => {
  const { result, calls } = runSynchronizer();
  const writes = calls.split("\n").filter((line) => line.startsWith("glab:write:"));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes, keys.map((key) => `glab:write:set:${key}:value-ok`));
  assert.equal(calls.split("\n").filter((line) => line.includes("glab:api:metadata:")).length, 2);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("existing wildcard variables are migrated to aws-lab", () => {
  const { result, calls } = runSynchronizer({
    variableMetadata: metadata(keys.map((key) => [key])),
  });
  const writes = calls.split("\n").filter((line) => line.startsWith("glab:write:"));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes, keys.map((key) => `glab:write:migrate:${key}:value-ok`));
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("existing aws-lab variables are updated in place with full metadata flags", () => {
  const { result, calls } = runSynchronizer({
    variableMetadata: metadata(keys.map((key) => [key, "aws-lab"])),
  });
  const writes = calls.split("\n").filter((line) => line.startsWith("glab:write:"));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes, keys.map((key) => `glab:write:update:${key}:value-ok`));
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("metadata from a later NDJSON page is classified as an existing variable", () => {
  const { result, calls } = runSynchronizer({
    variableMetadata: metadata([
      ["UNRELATED_VARIABLE"],
      [keys[0]],
    ], true),
  });
  const writes = calls.split("\n").filter((line) => line.startsWith("glab:write:"));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes, [
    `glab:write:migrate:${keys[0]}:value-ok`,
    `glab:write:set:${keys[1]}:value-ok`,
    `glab:write:set:${keys[2]}:value-ok`,
  ]);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("post-write metadata mismatch fails without leaking values", () => {
  const { result, calls } = runSynchronizer({
    postWriteMetadata: metadata([
      [keys[0], "aws-lab"],
      [keys[1], "aws-lab", true, { masked: false }],
      [keys[2], "aws-lab"],
    ]),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /post-write GitLab variable metadata verification failed/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("AWS endpoint environment overrides fail before external calls", () => {
  const { result, calls } = runSynchronizer({
    envOverrides: { AWS_ENDPOINT_URL_STS: "https://example.invalid" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS endpoint overrides are not allowed/);
  assert.equal(calls, "");
});

for (const [name, options] of [
  ["profile endpoint", { configuredEndpoint: "https://example.invalid" }],
  ["profile services section", { configuredServices: "local-services" }],
]) {
  test(`${name} is rejected before GitLab or credential access`, () => {
    const { result, calls } = runSynchronizer(options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configured AWS endpoints are not allowed/);
    assert.doesNotMatch(calls, /glab:|export-credentials/);
  });
}

test("AWS caller must be the exact voclabs assumed role", () => {
  const { result, calls } = runSynchronizer({
    callerArn: "arn:aws:sts::248880318395:assumed-role/other-role/session",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS caller/);
  assert.doesNotMatch(calls, /export-credentials|glab:write:/);
});

test("preflight rejects existing non-hidden variables before credential export or mutation", () => {
  const { result, calls } = runSynchronizer({
    variableMetadata: metadata([[keys[0], "*", false]]),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must already be hidden/);
  assert.doesNotMatch(calls, /export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("preflight rejects duplicate or scoped target metadata before credential export", () => {
  const { result, calls } = runSynchronizer({
    variableMetadata: metadata([
      [keys[0], "*", true],
      [keys[0], "production", true],
    ]),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambiguous GitLab variable metadata/);
  assert.doesNotMatch(calls, /export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("credential-bearing origins are rejected before repository resolution", () => {
  const { result, calls } = runSynchronizer({
    origin: "https://opaque@GitLab.invalid/group/project.git",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe Git origin URL/);
  assert.doesNotMatch(calls, /glab:repo-view|glab:api|export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("mismatched repository-view metadata is rejected before AWS credential export or mutation", () => {
  const { result, calls } = runSynchronizer({
    repositoryView: JSON.stringify({
      id: 42,
      web_url: "https://git.inteli.edu.br/group/other-project",
      path_with_namespace: "group/other-project",
    }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitLab repository URL does not match/);
  assert.doesNotMatch(calls, /sts get-caller|ecr describe|ecs describe|export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("wrong AWS account prevents credential export and GitLab writes", () => {
  const { result, calls } = runSynchronizer({ account: "000000000000" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS account/);
  assert.doesNotMatch(calls, /export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

test("wrong ECR repository result prevents credential export and GitLab writes", () => {
  const { result, calls } = runSynchronizer({
    ecrResult: "unexpected-repository",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected ECR repository result/);
  assert.doesNotMatch(calls, /export-credentials|glab:write:/);
  assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
});

for (const [name, ecsResult] of [
  ["missing", "None\t0"],
  ["inactive", "INACTIVE\t0"],
  ["failed", "ACTIVE\t1"],
]) {
  test(`${name} ECS service response prevents credential export and GitLab writes`, () => {
    const { result, calls } = runSynchronizer({ ecsResult });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ECS service is not exactly ACTIVE with zero failures/);
    assert.match(calls, /aws:.*ecs describe-services/);
    assert.doesNotMatch(calls, /export-credentials|glab:write:/);
    assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
  });
}

for (const [failedAttempt, completedKeys, failedKey] of [
  [2, [keys[0]], keys[1]],
  [3, [keys[0], keys[1]], keys[2]],
]) {
  test(`failed write ${failedAttempt} reports non-sensitive partial-update guidance`, () => {
    const { result, calls } = runSynchronizer({ failWriteAttempt: failedAttempt });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /partial GitLab variable update/);
    assert.match(result.stderr, new RegExp(`completed: ${completedKeys.join(", ")}`));
    assert.match(result.stderr, new RegExp(`failed: ${failedKey}`));
    assert.match(result.stderr, /re-run the synchronizer/);
    assertNoCredentialFixtureLeaks(`${result.stdout}${result.stderr}${calls}`);
  });
}

test("wildcard migration never places a credential in a process argument", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /--arg\s+value\s+"\$value"/);
  assert.match(source, /printf '%s' "\$value" \| jq -Rsc/);
});

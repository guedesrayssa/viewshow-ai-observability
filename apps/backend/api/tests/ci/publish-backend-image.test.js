const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/ci/publish-backend-image.sh");
const commitSha = "abc123def456abc123def456abc123def456abcd";
const digest = `sha256:${"a".repeat(64)}`;

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runPublisher({
  imageExists = true,
  imageDigest = digest,
  actualAccount = "248880318395",
  callerArn = "arn:aws:sts::248880318395:assumed-role/voclabs/test-session",
  imageRevision = commitSha,
  envOverrides = {},
} = {}) {
  assert.ok(fs.existsSync(script), "publication helper must exist");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-publish-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const state = path.join(directory, "state");
  const dotenv = path.join(directory, "backend-image.env");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(state, imageExists ? "existing" : "missing");

  writeExecutable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${AWS_PAGER+x}:\${AWS_PAGER:-}" == "x:" ]] || { echo "pager-not-disabled" >&2; exit 91; }
[[ "\${AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:-}" == "true" ]] || { echo "endpoints-not-disabled" >&2; exit 92; }
printf 'aws:%s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "sts get-caller-identity --output json" ]]; then
  printf '{"Account":"%s","Arn":"%s"}\n' "$ACTUAL_ACCOUNT" "$CALLER_ARN"
elif [[ "$*" == "ecr describe-images --region us-east-1 --repository-name monitoracao-api --image-ids imageTag=$EXPECTED_SHA --query imageDetails[0].imageDigest --output text" ]]; then
  if [[ "$(cat "$STATE_FILE")" == "missing" ]]; then
    echo 'ImageNotFoundException' >&2
    exit 254
  fi
  printf '%s\n' "$IMAGE_DIGEST"
elif [[ "$*" == "ecr get-login-password --region us-east-1" ]]; then
  printf 'fixture-password'
else
  echo "unexpected aws call: $*" >&2
  exit 2
fi
`,
  );

  writeExecutable(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'docker:%s\n' "$*" >>"$CALL_LOG"
registry="248880318395.dkr.ecr.us-east-1.amazonaws.com"
image="$registry/monitoracao-api:$EXPECTED_SHA"
cache="$registry/monitoracao-api:buildcache"
if [[ "$*" == "login --username AWS --password-stdin $registry" ]]; then
  [[ "$(cat)" == "fixture-password" ]] || exit 3
elif [[ "$*" == "pull $image" ]]; then
  :
elif [[ "$*" == "image inspect $image --format {{ index .Config.Labels \\\"org.opencontainers.image.revision\\\" }}" ]]; then
  printf '%s\n' "$IMAGE_REVISION"
elif [[ "$*" == "buildx build --platform linux/amd64 --load --cache-from type=registry,ref=$cache --cache-to type=registry,ref=$cache,mode=max,image-manifest=true,oci-mediatypes=true --label org.opencontainers.image.revision=$EXPECTED_SHA --tag $image apps/backend/api" ]]; then
  :
elif [[ "$*" == "push $image" ]]; then
  printf 'existing' >"$STATE_FILE"
else
  echo "unexpected docker call: $*" >&2
  exit 2
fi
`,
  );

  const result = spawnSync(script, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      STATE_FILE: state,
      ACTUAL_ACCOUNT: actualAccount,
      CALLER_ARN: callerArn,
      IMAGE_DIGEST: imageDigest,
      IMAGE_REVISION: imageRevision,
      EXPECTED_SHA: commitSha,
      AWS_ACCOUNT_ID: "248880318395",
      AWS_DEFAULT_REGION: "us-east-1",
      ECR_REPOSITORY: "monitoracao-api",
      CI_COMMIT_SHA: commitSha,
      BACKEND_IMAGE_ENV_FILE: dotenv,
      ...envOverrides,
    },
  });

  const execution = {
    result,
    calls: fs.readFileSync(calls, "utf8"),
    dotenv: fs.existsSync(dotenv) ? fs.readFileSync(dotenv, "utf8") : "",
  };
  fs.rmSync(directory, { recursive: true });
  return execution;
}

test("existing SHA image is reused and exports its exact digest", () => {
  const { result, calls, dotenv } = runPublisher();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.match(calls, /docker:pull .*monitoracao-api:/);
  assert.match(calls, /docker:image inspect/);
  assert.doesNotMatch(calls, /docker:push|docker:buildx build/);
});

test("missing SHA image is built once, pushed once, and resolved by digest", () => {
  const { result, calls, dotenv } = runPublisher({ imageExists: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:push")).length, 1);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:buildx build")).length, 1);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecr describe-images")).length, 2);
});

for (const [variable, value] of Object.entries({
  AWS_ACCOUNT_ID: "000000000000",
  AWS_DEFAULT_REGION: "us-west-2",
  ECR_REPOSITORY: "other-api",
  CI_COMMIT_SHA: "short",
})) {
  test(`wrong publication binding ${variable} fails before external calls`, () => {
    const { result, calls, dotenv } = runPublisher({ envOverrides: { [variable]: value } });
    assert.notEqual(result.status, 0);
    assert.equal(calls, "");
    assert.equal(dotenv, "");
  });
}

test("AWS endpoint overrides fail before external calls", () => {
  const { result, calls } = runPublisher({
    envOverrides: { AWS_ENDPOINT_URL_ECR: "https://example.invalid" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS endpoint overrides are not allowed/);
  assert.equal(calls, "");
});

test("caller must be the expected voclabs assumed role", () => {
  const { result, calls } = runPublisher({
    callerArn: "arn:aws:sts::248880318395:assumed-role/other-role/test-session",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS caller/);
  assert.doesNotMatch(calls, /ecr |docker:/);
});

test("invalid ECR digest never creates a dotenv artifact", () => {
  const { result, calls, dotenv } = runPublisher({ imageDigest: "sha256:testdigest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid ECR image digest/);
  assert.match(calls, /ecr describe-images/);
  assert.equal(dotenv, "");
});

test("existing SHA image must retain the commit revision label", () => {
  const { result, dotenv } = runPublisher({ imageRevision: "wrong-revision" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected source revision/);
  assert.equal(dotenv, "");
});

test("publisher declares the command used to replay an ECR error", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /for command_name in [^\n]*\bcat\b/);
});

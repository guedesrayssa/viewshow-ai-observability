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
  pushDigest = digest,
  ecrDigest = digest,
  actualAccount = "248880318395",
  callerArn = "arn:aws:sts::248880318395:assumed-role/voclabs/test-session",
  imageRevision = commitSha,
  repositoryHead = commitSha,
  envOverrides = {},
} = {}) {
  assert.ok(fs.existsSync(script), "publication helper must exist");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-publish-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const dotenv = path.join(directory, "backend-image.env");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");

  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git:%s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "rev-parse --verify HEAD" ]]; then
  printf '%s\n' "$REPOSITORY_HEAD"
else
  echo "unexpected git call: $*" >&2
  exit 2
fi
`,
  );

  writeExecutable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${AWS_PAGER+x}:\${AWS_PAGER:-}" == "x:" ]] || { echo "pager-not-disabled" >&2; exit 91; }
[[ "\${AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:-}" == "true" ]] || { echo "endpoints-not-disabled" >&2; exit 92; }
printf 'aws:%s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "sts get-caller-identity --output json" ]]; then
  printf '{"Account":"%s","Arn":"%s"}\n' "$ACTUAL_ACCOUNT" "$CALLER_ARN"
elif [[ "$*" == "ecr get-login-password --region us-east-1" ]]; then
  printf 'fixture-password'
elif [[ "$*" == "ecr describe-images --region us-east-1 --repository-name monitoracao-api --image-ids imageTag=$EXPECTED_SHA --query imageDetails[0].imageDigest --output text" ]]; then
  printf '%s\n' "$ECR_DIGEST"
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
tagged_image="$registry/monitoracao-api:$EXPECTED_SHA"
digest_image="$registry/monitoracao-api@$PUSH_DIGEST"
cache="$registry/monitoracao-api:buildcache"
if [[ "$*" == "login --username AWS --password-stdin $registry" ]]; then
  [[ "$(cat)" == "fixture-password" ]] || exit 3
elif [[ "$*" == "buildx build --platform linux/amd64 --load --cache-from type=registry,ref=$cache --cache-to type=registry,ref=$cache,mode=max,image-manifest=true,oci-mediatypes=true --label org.opencontainers.image.revision=$EXPECTED_SHA --tag $tagged_image apps/backend/api" ]]; then
  :
elif [[ "$*" == "push $tagged_image" ]]; then
  printf 'layer: pushed\n%s: digest: %s size: 1234\n' "$EXPECTED_SHA" "$PUSH_DIGEST"
elif [[ "$*" == "pull $digest_image" ]]; then
  :
elif [[ "$*" == "image inspect $digest_image --format {{ index .Config.Labels \\"org.opencontainers.image.revision\\" }}" ]]; then
  printf '%s\n' "$IMAGE_REVISION"
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
      ACTUAL_ACCOUNT: actualAccount,
      CALLER_ARN: callerArn,
      PUSH_DIGEST: pushDigest,
      ECR_DIGEST: ecrDigest,
      IMAGE_REVISION: imageRevision,
      REPOSITORY_HEAD: repositoryHead,
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

test("publisher builds and pushes this checkout then inspects only its digest", () => {
  const { result, calls, dotenv } = runPublisher();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:buildx build")).length, 1);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:push")).length, 1);
  assert.match(calls, new RegExp(`docker:pull .*monitoracao-api@${digest}`));
  assert.match(calls, new RegExp(`docker:image inspect .*monitoracao-api@${digest}`));
  assert.doesNotMatch(calls, /docker:(pull|image inspect) .*monitoracao-api:/);
  assert.ok(calls.indexOf("docker:push") < calls.indexOf("ecr describe-images"));
});

test("ECR tag overwrite after push prevents artifact creation", () => {
  const otherDigest = `sha256:${"b".repeat(64)}`;
  const { result, calls, dotenv } = runPublisher({ ecrDigest: otherDigest });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ECR digest does not match docker push digest/);
  assert.doesNotMatch(calls, /docker:pull|docker:image inspect/);
  assert.equal(dotenv, "");
});

test("invalid docker push digest fails before ECR resolution", () => {
  const { result, calls, dotenv } = runPublisher({ pushDigest: "sha256:invalid" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docker push did not report exactly one valid digest/);
  assert.doesNotMatch(calls, /ecr describe-images/);
  assert.equal(dotenv, "");
});

test("repository HEAD mismatch fails before AWS or Docker calls", () => {
  const { result, calls, dotenv } = runPublisher({ repositoryHead: "f".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI_COMMIT_SHA does not match checked-out HEAD/);
  assert.deepEqual(calls.trim().split("\n"), ["git:rev-parse --verify HEAD"]);
  assert.equal(dotenv, "");
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
  const { result, calls } = runPublisher({ envOverrides: { AWS_ENDPOINT_URL_ECR: "https://example.invalid" } });
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

test("immutable image must retain the commit revision label", () => {
  const { result, dotenv } = runPublisher({ imageRevision: "wrong-revision" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected source revision/);
  assert.equal(dotenv, "");
});

test("publisher declares git as a fail-fast dependency", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /for command_name in [^\n]*\bgit\b/);
});

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
const localImageId = `sha256:${"c".repeat(64)}`;
const imageIdentity = `${localImageId} ["sha256:${"d".repeat(64)}"]`;
const dockerImageMediaType = "application/vnd.docker.distribution.manifest.v2+json";
const ociImageMediaType = "application/vnd.oci.image.manifest.v1+json";
const ociIndexMediaType = "application/vnd.oci.image.index.v1+json";
const dockerManifestListMediaType = "application/vnd.docker.distribution.manifest.list.v2+json";

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runPublisher({
  describeResults = [null, null, digest],
  describeMediaTypes = [],
  pushDigest = digest,
  localIdentity = imageIdentity,
  remoteIdentity = imageIdentity,
  remotePlatform = "linux/amd64",
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
  const describeCount = path.join(directory, "describe-count");
  const dotenv = path.join(directory, "backend-image.env");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(describeCount, "0");

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
elif [[ "$*" == "ecr describe-images --region us-east-1 --repository-name monitoracao-api --image-ids imageTag=$EXPECTED_SHA --query imageDetails[0].{digest:imageDigest,mediaType:imageManifestMediaType} --output json" ]]; then
  count="$(<"$DESCRIBE_COUNT_FILE")"
  count=$((count + 1))
  printf '%s' "$count" >"$DESCRIBE_COUNT_FILE"
  if ((count > DESCRIBE_RESULT_COUNT)); then
    echo "unexpected ECR describe-images call $count" >&2
    exit 2
  fi
  result_name="DESCRIBE_RESULT_$count"
  result="\${!result_name}"
  if [[ "$result" == "__ABSENT__" ]]; then
    echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2
    exit 254
  fi
  media_name="DESCRIBE_MEDIA_TYPE_$count"
  printf '{"digest":"%s","mediaType":"%s"}\n' "$result" "\${!media_name}"
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
cache="$registry/monitoracao-api:buildcache"
identity_format='{{.Id}} {{json .RootFS.Layers}}'
revision_format='{{ index .Config.Labels "org.opencontainers.image.revision" }}'
platform_format='{{.Os}}/{{.Architecture}}'
if [[ "$*" == "login --username AWS --password-stdin $registry" ]]; then
  [[ "$(cat)" == "fixture-password" ]] || exit 3
elif [[ "$1" == "buildx" && "$2" == "build" ]]; then
  args=("$@")
  iid_file=""
  for ((index = 0; index < \${#args[@]}; index += 1)); do
    if [[ "\${args[$index]}" == "--iidfile" ]]; then
      iid_file="\${args[$((index + 1))]}"
      args[$((index + 1))]="IIDFILE"
    fi
  done
  expected="buildx build --platform linux/amd64 --load --iidfile IIDFILE --cache-from type=registry,ref=$cache --cache-to type=registry,ref=$cache,mode=max,image-manifest=true,oci-mediatypes=true --label org.opencontainers.image.revision=$EXPECTED_SHA --tag $tagged_image apps/backend/api"
  [[ "\${args[*]}" == "$expected" && -n "$iid_file" ]] || { echo "unexpected docker build: $*" >&2; exit 2; }
  printf '%s\n' "$LOCAL_IMAGE_ID" >"$iid_file"
elif [[ "$*" == "push $tagged_image" ]]; then
  printf 'layer: pushed\n%s: digest: %s size: 1234\n' "$EXPECTED_SHA" "$PUSH_DIGEST"
elif [[ "$1" == "pull" && "$2" =~ ^$registry/monitoracao-api@sha256:[0-9a-f]{64}$ ]]; then
  :
elif [[ "$1" == "image" && "$2" == "inspect" && "$3" == "$LOCAL_IMAGE_ID" && "$4" == "--format" && "$5" == "$identity_format" ]]; then
  printf '%s\n' "$LOCAL_IDENTITY"
elif [[ "$1" == "image" && "$2" == "inspect" && "$3" =~ ^$registry/monitoracao-api@sha256:[0-9a-f]{64}$ && "$4" == "--format" && "$5" == "$identity_format" ]]; then
  printf '%s\n' "$REMOTE_IDENTITY"
elif [[ "$1" == "image" && "$2" == "inspect" && "$3" =~ ^$registry/monitoracao-api@sha256:[0-9a-f]{64}$ && "$4" == "--format" && "$5" == "$revision_format" ]]; then
  printf '%s\n' "$IMAGE_REVISION"
elif [[ "$1" == "image" && "$2" == "inspect" && "$3" =~ ^$registry/monitoracao-api@sha256:[0-9a-f]{64}$ && "$4" == "--format" && "$5" == "$platform_format" ]]; then
  printf '%s\n' "$REMOTE_PLATFORM"
else
  echo "unexpected docker call: $*" >&2
  exit 2
fi
`,
  );

  const describeEnvironment = Object.fromEntries(
    describeResults.map((value, index) => [`DESCRIBE_RESULT_${index + 1}`, value ?? "__ABSENT__"]),
  );
  const mediaTypeEnvironment = Object.fromEntries(
    describeResults.map((_, index) => [
      `DESCRIBE_MEDIA_TYPE_${index + 1}`,
      describeMediaTypes[index] ?? dockerImageMediaType,
    ]),
  );
  const result = spawnSync(script, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      DESCRIBE_COUNT_FILE: describeCount,
      DESCRIBE_RESULT_COUNT: String(describeResults.length),
      ...describeEnvironment,
      ...mediaTypeEnvironment,
      ACTUAL_ACCOUNT: actualAccount,
      CALLER_ARN: callerArn,
      PUSH_DIGEST: pushDigest,
      LOCAL_IMAGE_ID: localImageId,
      LOCAL_IDENTITY: localIdentity,
      REMOTE_IDENTITY: remoteIdentity,
      REMOTE_PLATFORM: remotePlatform,
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

test("absent SHA tag builds, checks again, pushes once, and validates only the digest", () => {
  const { result, calls, dotenv } = runPublisher();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:buildx build")).length, 1);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:push")).length, 1);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecr describe-images")).length, 3);
  assert.match(calls, new RegExp(`docker:pull .*monitoracao-api@${digest}`));
  assert.match(calls, new RegExp(`docker:image inspect .*monitoracao-api@${digest}`));
  assert.doesNotMatch(calls, new RegExp(`docker:(pull|image inspect) .*monitoracao-api:${commitSha}`));
});

test("identical existing SHA tag is reused without a push", () => {
  const { result, calls, dotenv } = runPublisher({ describeResults: [digest, digest] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("docker:buildx build")).length, 1);
  assert.doesNotMatch(calls, /docker:push/);
  assert.ok(calls.indexOf("docker:buildx build") < calls.indexOf("ecr describe-images"));
  assert.match(calls, new RegExp(`docker:pull .*monitoracao-api@${digest}`));
});

test("single-platform OCI image manifest is accepted", () => {
  const { result, calls, dotenv } = runPublisher({
    describeResults: [digest, digest],
    describeMediaTypes: [ociImageMediaType, ociImageMediaType],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.doesNotMatch(calls, /docker:push/);
});

test("different existing SHA tag identity fails without a push or artifact", () => {
  const differentIdentity = `sha256:${"e".repeat(64)} ["sha256:${"f".repeat(64)}"]`;
  const { result, calls, dotenv } = runPublisher({
    describeResults: [digest],
    remoteIdentity: differentIdentity,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing SHA tag does not identify the local build/);
  assert.doesNotMatch(calls, /docker:push/);
  assert.equal(dotenv, "");
});

for (const mediaType of [ociIndexMediaType, dockerManifestListMediaType]) {
  test(`multi-platform ECR media type ${mediaType} is rejected before pull or push`, () => {
    const { result, calls, dotenv } = runPublisher({
      describeResults: [digest, digest],
      describeMediaTypes: [mediaType, mediaType],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single-platform image manifest/);
    assert.doesNotMatch(calls, /docker:pull|docker:image inspect|docker:push/);
    assert.equal(dotenv, "");
  });
}

test("digest-pulled ARM image is rejected before artifact creation", () => {
  const { result, calls, dotenv } = runPublisher({
    describeResults: [digest, digest],
    remotePlatform: "linux/arm64",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected linux\/amd64/);
  assert.doesNotMatch(calls, /docker:push/);
  assert.equal(dotenv, "");
});

test("existing SHA tag changing during identity verification fails closed", () => {
  const otherDigest = `sha256:${"b".repeat(64)}`;
  const { result, calls, dotenv } = runPublisher({ describeResults: [digest, otherDigest] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA tag changed during verification/);
  assert.doesNotMatch(calls, /docker:push/);
  assert.equal(dotenv, "");
});

test("SHA tag appearing before push is reused only after exact identity verification", () => {
  const { result, calls, dotenv } = runPublisher({ describeResults: [null, digest, digest] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dotenv, `BACKEND_IMAGE_DIGEST=${digest}\n`);
  assert.doesNotMatch(calls, /docker:push/);
  assert.match(calls, new RegExp(`docker:pull .*monitoracao-api@${digest}`));
});

test("ECR tag race after push prevents artifact creation", () => {
  const otherDigest = `sha256:${"b".repeat(64)}`;
  const { result, calls, dotenv } = runPublisher({ describeResults: [null, null, otherDigest] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ECR digest does not match docker push digest/);
  assert.doesNotMatch(calls, /docker:pull|docker:image inspect/);
  assert.equal(dotenv, "");
});

test("invalid docker push digest fails before post-push validation", () => {
  const { result, calls, dotenv } = runPublisher({
    describeResults: [null, null],
    pushDigest: "sha256:invalid",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docker push did not report exactly one valid digest/);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecr describe-images")).length, 2);
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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const deployScript = path.join(
  repositoryRoot,
  "apps/frontend/deploy/deploy-amplify.sh",
);

function executable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function runDeploy(overrides = {}) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "deploy-amplify-test-"),
  );
  const binaryDirectory = path.join(temporaryDirectory, "bin");
  const outputDirectory = path.join(temporaryDirectory, "out");
  const commandLog = path.join(temporaryDirectory, "commands.log");
  fs.mkdirSync(binaryDirectory);
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(outputDirectory, "index.html"), "dashboard");

  executable(
    path.join(binaryDirectory, "aws"),
    `#!/usr/bin/env bash
set -eu
printf 'aws %s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1 $2" in
  "sts get-caller-identity")
    printf '%s\t%s\n' "$FAKE_ACCOUNT" "$FAKE_ARN"
    ;;
  "amplify list-apps")
    printf '%s' "$FAKE_APPS"
    ;;
  "amplify list-tags-for-resource")
    printf '%s\t%s\n' "$FAKE_STACK_TAG" "$FAKE_MANAGED_BY_TAG"
    ;;
  "amplify create-deployment")
    printf 'job-123\thttps://upload.invalid/archive?secret=presigned-canary\n'
    ;;
  "amplify start-deployment")
    printf 'PENDING\n'
    ;;
  "amplify get-job")
    printf 'SUCCEED\n'
    ;;
  *)
    exit 91
    ;;
esac
`,
  );
  executable(
    path.join(binaryDirectory, "zip"),
    `#!/usr/bin/env bash
set -eu
printf 'zip\n' >> "$FAKE_COMMAND_LOG"
for argument in "$@"; do
  case "$argument" in
    *.zip) : > "$argument" ;;
  esac
done
`,
  );
  executable(
    path.join(binaryDirectory, "curl"),
    `#!/usr/bin/env bash
set -eu
printf 'curl first=%s upload\n' "\${1:-}" >> "$FAKE_COMMAND_LOG"
if [[ "\${1:-}" != "--disable" ]]; then
  echo 'curl must disable user configuration first' >&2
  exit 64
fi
if [[ "$FAKE_CURL_FAIL" == "true" ]]; then
  echo 'curl failed for https://amplify-deployment.s3.amazonaws.com/archive?secret=presigned-canary' >&2
  exit 22
fi
`,
  );

  const env = {
    ...process.env,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_REGION: "us-east-1",
    FAKE_COMMAND_LOG: commandLog,
    FAKE_ACCOUNT: overrides.account ?? "999999999999",
    FAKE_ARN:
      overrides.arn ??
      "arn:aws:sts::999999999999:assumed-role/voclabs/session-123",
    FAKE_APPS:
      overrides.apps ??
      "isolated-app-id\tarn:aws:amplify:us-east-1:999999999999:apps/isolated-app-id\texample.amplifyapp.com\n",
    FAKE_STACK_TAG: overrides.stackTag ?? "g05-sprint3-entrega",
    FAKE_MANAGED_BY_TAG: overrides.managedByTag ?? "terraform",
    FAKE_CURL_FAIL: overrides.curlFails ? "true" : "false",
    ...(overrides.envOverrides ?? {}),
  };
  for (const variableName of overrides.unsetEnvironment ?? []) {
    delete env[variableName];
  }

  const result = spawnSync("bash", [deployScript, outputDirectory], {
    encoding: "utf8",
    env,
  });

  const commands = fs.existsSync(commandLog)
    ? fs.readFileSync(commandLog, "utf8")
    : "";
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  return { ...result, commands };
}

test("resolves one tagged isolated app before deploying its production branch", () => {
  const result = runDeploy();

  assert.equal(result.status, 0, result.stderr);
  const identityCheck = result.commands.indexOf("sts get-caller-identity");
  const appCheck = result.commands.indexOf("amplify list-apps");
  const tagCheck = result.commands.indexOf("amplify list-tags-for-resource");
  const mutation = result.commands.indexOf("amplify create-deployment");
  assert.ok(identityCheck >= 0, "must check the effective AWS caller");
  assert.ok(appCheck > identityCheck, "must resolve the app after identity");
  assert.ok(tagCheck > appCheck, "must inspect ownership tags after resolving the app");
  assert.ok(mutation > tagCheck, "must validate ownership before deployment");
  assert.match(
    result.commands,
    /amplify list-apps .*apps\[\?name==`view-show-painel`\]/,
  );
  assert.match(result.commands, /amplify start-deployment/);
  assert.match(result.commands, /curl first=--disable upload/);
  for (const call of result.commands
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("aws "))) {
    assert.match(call, /--region us-east-1/);
  }
  assert.doesNotMatch(result.stdout + result.stderr, /presigned-canary/);
});

test("passes --disable as curl's first argument", () => {
  const result = runDeploy();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /^curl first=--disable upload$/m);
});

for (const [name, overrides, expectedError] of [
  // A conta deixou de ser um literal do repositório: ela vem da própria
  // identidade. O que sobra, e é mais forte, é a CONSISTÊNCIA da identidade —
  // conta e ARN têm de concordar — e o app Amplify pertencer à conta do
  // chamador. Os dois casos abaixo travam essas duas propriedades.
  [
    "identity whose account disagrees with its ARN",
    { account: "111122223333" },
    /caller AWS ativo/i,
  ],
  [
    "Amplify app owned by another account",
    {
      apps:
        "isolated-app-id\tarn:aws:amplify:us-east-1:111122223333:apps/isolated-app-id\texample.amplifyapp.com\n",
    },
    /ARN inesperado para o app Amplify/i,
  ],
  [
    "wrong caller role",
    {
      arn: "arn:aws:sts::999999999999:assumed-role/other-role/session-123",
    },
    /caller AWS ativo/i,
  ],
  ["missing Amplify app", { apps: "" }, /exatamente um app Amplify/i],
  [
    "ambiguous Amplify app",
    {
      apps:
        "app-one\tarn:aws:amplify:us-east-1:999999999999:apps/app-one\tone.amplifyapp.com\n" +
        "app-two\tarn:aws:amplify:us-east-1:999999999999:apps/app-two\ttwo.amplifyapp.com\n",
    },
    /exatamente um app Amplify/i,
  ],
  ["wrong Stack tag", { stackTag: "legacy-stack" }, /tags de propriedade/i],
  ["wrong ManagedBy tag", { managedByTag: "manual" }, /tags de propriedade/i],
]) {
  test(`rejects ${name} before creating an Amplify deployment`, () => {
    const result = runDeploy(overrides);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.doesNotMatch(result.commands, /amplify create-deployment/);
    assert.doesNotMatch(result.stdout + result.stderr, /presigned-canary/);
  });
}

for (const [name, envOverrides, expectedError] of [
  [
    "conflicting AWS_DEFAULT_REGION",
    { AWS_DEFAULT_REGION: "us-west-2" },
    /região AWS conflitante/i,
  ],
  [
    "conflicting AWS_REGION",
    { AWS_REGION: "us-west-2" },
    /região AWS conflitante/i,
  ],
  [
    "AWS endpoint override",
    { AWS_ENDPOINT_URL_AMPLIFY: "https://example.invalid" },
    /AWS endpoint overrides are not allowed/,
  ],
]) {
  test(`rejects ${name} before any external command`, () => {
    const result = runDeploy({ envOverrides });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.equal(result.commands, "");
  });
}

test("does not expose a presigned upload URL when curl fails", () => {
  const result = runDeploy({ curlFails: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /upload do artefato falhou/i);
  assert.doesNotMatch(result.stdout + result.stderr, /presigned-canary/);
  assert.doesNotMatch(result.commands, /amplify start-deployment/);
});

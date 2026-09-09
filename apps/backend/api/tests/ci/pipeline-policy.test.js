const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipeline = fs.readFileSync(
  path.resolve(__dirname, "../../../../../.gitlab-ci.yml"),
  "utf8",
);
const gitignore = fs.readFileSync(
  path.resolve(__dirname, "../../../../../.gitignore"),
  "utf8",
);
const deployReadme = fs.readFileSync(
  path.resolve(__dirname, "../../deploy/README.md"),
  "utf8",
);

function topLevelBlock(name, source = pipeline) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedName}:[^\\n]*\\n`, "m").exec(source);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing top-level block ${name}`);
  const remainder = source.slice(start + match[0].length);
  const next = remainder.search(/^\S[^\n]*:\n/m);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function jobPropertyBlock(name, job) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^  ${escapedName}:[^\\n]*(?:\\n|$)`, "m").exec(job);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing job property ${name}`);
  const remainder = job.slice(start + match[0].length);
  const next = remainder.search(/^  [^\s#][^:\n]*:[^\n]*(?:\n|$)/m);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function executorReferences(source = pipeline) {
  return [
    ...[...source.matchAll(/^[ \t]+image:[ \t]+(\S+)[ \t]*$/gm)].map(
      (match) => match[1],
    ),
    ...[
      ...source.matchAll(
        /^[ \t]+image:[ \t]*\n[ \t]+name:[ \t]+(\S+)[ \t]*$/gm,
      ),
    ].map((match) => match[1]),
    ...[...source.matchAll(/^[ \t]+-[ \t]+name:[ \t]+(\S+)[ \t]*$/gm)].map(
      (match) => match[1],
    ),
  ];
}

function assertBackendValidationIsLocalOnly(job) {
  assert.match(
    job,
    /^  services:\n    - name: amazon\/dynamodb-local:2\.6\.1@sha256:1856c05cc66a0e49dc1099e483ad2851477eeebe2135250ac11a1d1227db54b1\n      alias: dynamodb$/m,
  );
  assert.match(
    job,
    /^  variables:\n    AWS_ACCESS_KEY_ID: "local"\n    AWS_SECRET_ACCESS_KEY: "local"\n    AWS_REGION: "us-east-1"\n    DYNAMODB_ENDPOINT: "http:\/\/dynamodb:8000"$/m,
  );
  assert.match(job, /^    - npm run test:e2e$/m);
  const script = jobPropertyBlock("script", job);
  assert.ok(script, "validate_backend must declare a script");
  const regularSuite = script.indexOf("    - npm test\n");
  const policySuite = script.indexOf("    - npm run test:ci-policy\n");
  const liveSuite = script.indexOf("    - npm run test:e2e\n");
  assert.ok(
    regularSuite !== -1 &&
      policySuite > regularSuite &&
      liveSuite > policySuite,
    "npm test, npm run test:ci-policy, and npm run test:e2e must run in that order",
  );
  assert.doesNotMatch(
    job,
    /environment:|sync-aws-gitlab-credentials|publish-backend-image|deploy-ecs|\baws\s/,
  );
  assert.doesNotMatch(
    job,
    /AWS_SESSION_TOKEN|AWS_PROFILE|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_ROLE_ARN/,
  );
  const normalizedScript = script.replace(/\\\r?\n[ \t]*/g, " ");
  assert.doesNotMatch(
    normalizedScript,
    /docker\s+(?:push\b|buildx\s+build\b[^\n]*--push\b)|npm\s+publish\b|(?:terraform|tofu)\s+(?:apply|destroy|import|taint|untaint|force-unlock|state\s+(?:mv|rm|push))\b|pulumi\s+(?:up|destroy|import|state\s+delete)\b|kubectl\s+(?:apply|create|delete|patch|replace|rollout|scale|set)\b|helm\s+(?:install|upgrade|uninstall|rollback)\b|\b(?:deploy|publish)\b/i,
    "validate_backend must not publish, deploy, or mutate infrastructure",
  );
}

test("topLevelBlock ignores similarly named hidden templates", () => {
  const source = [
    ".validate_backend:",
    "  script:",
    "    - echo template",
    "validate_backend:",
    "  script:",
    "    - echo actual",
    "",
  ].join("\n");

  assert.equal(
    topLevelBlock("validate_backend", source),
    "  script:\n    - echo actual\n",
  );
});

test("executorReferences includes scalar, object, and service images", () => {
  const source = [
    "scalar_job:",
    "  image: node:22-alpine@sha256:scalar",
    "object_job:",
    "  image:",
    "    name: amazon/aws-cli:2@sha256:object",
    '    entrypoint: [""]',
    "  services:",
    "    - name: docker:27-dind@sha256:service",
    "",
  ].join("\n");

  assert.deepEqual(executorReferences(source), [
    "node:22-alpine@sha256:scalar",
    "amazon/aws-cli:2@sha256:object",
    "docker:27-dind@sha256:service",
  ]);
});

test("pipeline conservatively cancels obsolete pre-deploy work", () => {
  assert.match(pipeline, /auto_cancel:\n\s+on_new_commit: conservative/);
  assert.doesNotMatch(pipeline, /on_new_commit: interruptible/);
  assert.match(topLevelBlock("deploy_backend_ecs"), /interruptible: false/);
  assert.match(
    topLevelBlock("deploy_backend_ecs"),
    /resource_group: monitoracao-api-service/,
  );
});

test("institutional runner connects to DinD without an unavailable TLS certificate volume", () => {
  assert.match(pipeline, /^  DOCKER_HOST: "tcp:\/\/docker:2375"$/m);
  assert.match(pipeline, /^  DOCKER_TLS_CERTDIR: ""$/m);
  assert.doesNotMatch(pipeline, /^  DOCKER_TLS_VERIFY:/m);
  assert.doesNotMatch(pipeline, /^  DOCKER_CERT_PATH:/m);
});

test("backend changes include the complete modular API and operational scripts", () => {
  const backendChanges = topLevelBlock(".mudou-backend");
  assert.match(backendChanges, /apps\/backend\/\*\*\/\*/);
  assert.match(backendChanges, /scripts\/ci\/\*\*\/\*/);
  assert.doesNotMatch(backendChanges, /docs\/superpowers/);
});

test("merge requests validate containers without protected AWS scope", () => {
  const job = topLevelBlock("validate_backend_container");
  assert.match(job, /^  tags:\n    - inteli-gitlab-runner-prd$/m);
  assert.match(job, /CI_PIPELINE_SOURCE == "merge_request_event"/);
  assert.doesNotMatch(job, /CI_PIPELINE_SOURCE == "push"/);
  assert.doesNotMatch(job, /environment:/);
  assert.doesNotMatch(job, /aws |AWS_ACCESS_KEY_ID|publish-backend-image/);
});

test("backend validation reuses npm cache without caching the install tree", () => {
  const job = topLevelBlock("validate_backend");
  assert.match(pipeline, /^  NPM_CONFIG_CACHE: "\$CI_PROJECT_DIR\/\.npm"$/m);
  assert.match(
    job,
    /^  cache:\n    key:\n      files:\n        - apps\/backend\/api\/package-lock\.json\n    paths:\n      - \.npm\/\n    policy: pull-push$/m,
  );
  assert.match(job, /^    - npm ci --prefer-offline --no-audit --fund=false$/m);
  assert.doesNotMatch(job, /^      - .*node_modules.*$/m);
});

test("backend validation installs the exact jq test dependency", () => {
  const job = topLevelBlock("validate_backend");
  assert.match(
    job,
    /^  before_script:\n    - apt-get update\n    - apt-get install --yes --no-install-recommends jq=1\.6-2\.1\+deb12u2\n    - rm -rf \/var\/lib\/apt\/lists\/\*\n    - cd apps\/backend\/api$/m,
  );
});

test("backend validation exercises the live API only against pinned DynamoDB Local", () => {
  const job = topLevelBlock("validate_backend");
  assert.doesNotThrow(() => assertBackendValidationIsLocalOnly(job));
});

test("backend validation rejects live E2E before the regular suite", () => {
  const job = topLevelBlock("validate_backend");
  const reordered = job.replace(
    "    - npm test\n    - npm run test:ci-policy\n    - npm run test:e2e",
    "    - npm run test:e2e\n    - npm test\n    - npm run test:ci-policy",
  );
  assert.notEqual(reordered, job);
  assert.throws(
    () => assertBackendValidationIsLocalOnly(reordered),
    /must run in that order/,
  );
});

test("backend validation rejects the CI policy suite after live E2E", () => {
  const job = topLevelBlock("validate_backend");
  const ordered = job.includes("    - npm run test:ci-policy\n")
    ? job
    : job.replace(
        "    - npm test\n    - npm run test:e2e",
        "    - npm test\n    - npm run test:ci-policy\n    - npm run test:e2e",
      );
  const reordered = ordered.replace(
    "    - npm test\n    - npm run test:ci-policy\n    - npm run test:e2e",
    "    - npm test\n    - npm run test:e2e\n    - npm run test:ci-policy",
  );
  assert.notEqual(reordered, ordered);
  assert.throws(
    () => assertBackendValidationIsLocalOnly(reordered),
    /must run in that order/,
  );
});

for (const [category, command] of [
  ["Docker publication", "docker push registry.example.test/api:ci"],
  ["package publication", "npm publish"],
  ["mutable Terraform", "terraform apply -auto-approve"],
  ["mutable Kubernetes", "kubectl apply -f deployment.yaml"],
  ["Helm deployment", "helm upgrade --install api ./chart"],
]) {
  test(`backend validation rejects ${category} commands`, () => {
    const job = topLevelBlock("validate_backend");
    const mutated = job.replace(
      "    - npm run test:e2e",
      `    - npm run test:e2e\n    - ${command}`,
    );
    assert.notEqual(mutated, job);
    assert.throws(
      () => assertBackendValidationIsLocalOnly(mutated),
      /must not publish, deploy, or mutate infrastructure/,
    );
  });
}

test("backend validation inspects commands inside multiline script entries", () => {
  const job = topLevelBlock("validate_backend");
  const mutated = job.replace(
    "    - npm run test:e2e",
    [
      "    - npm run test:e2e",
      "    - |",
      "      docker push registry.example.test/api:ci",
    ].join("\n"),
  );
  assert.notEqual(mutated, job);
  assert.throws(
    () => assertBackendValidationIsLocalOnly(mutated),
    /must not publish, deploy, or mutate infrastructure/,
  );
});

test("backend validation does not stop inspecting a multiline entry at a blank line", () => {
  const job = topLevelBlock("validate_backend");
  const mutated = job.replace(
    "    - npm run test:e2e",
    [
      "    - npm run test:e2e",
      "    - |",
      "      printf '%s\\n' validating",
      "",
      "      docker push registry.example.test/api:ci",
    ].join("\n"),
  );
  assert.notEqual(mutated, job);
  assert.throws(
    () => assertBackendValidationIsLocalOnly(mutated),
    /must not publish, deploy, or mutate infrastructure/,
  );
});

for (const [category, commandLines] of [
  [
    "split Docker push",
    ["      docker \\", "        push registry.example.test/api:ci"],
  ],
  [
    "split Buildx publication",
    ["      docker buildx build \\", "        --push ."],
  ],
  ["split package publication", ["      npm \\", "        publish"]],
]) {
  test(`backend validation rejects ${category} commands`, () => {
    const job = topLevelBlock("validate_backend");
    const mutated = job.replace(
      "    - npm run test:e2e",
      ["    - npm run test:e2e", "    - |", ...commandLines].join("\n"),
    );
    assert.notEqual(mutated, job);
    assert.throws(
      () => assertBackendValidationIsLocalOnly(mutated),
      /must not publish, deploy, or mutate infrastructure/,
    );
  });
}

test("develop publication is protected, digest-producing, and isolated from MR rules", () => {
  const job = topLevelBlock("publish_backend_image");
  assert.match(job, /^  tags:\n    - inteli-gitlab-runner-prd$/m);
  assert.match(job, /CI_PIPELINE_SOURCE == "push"/);
  assert.doesNotMatch(job, /merge_request_event/);
  assert.match(job, /environment:\n\s+name: aws-lab\n\s+action: prepare/);
  assert.match(job, /bash scripts\/ci\/publish-backend-image\.sh/);
  assert.match(job, /\. backend-image\.env/);
  assert.match(
    job,
    /smoke-container\.sh "\$\{AWS_ACCOUNT_ID\}.*@\$\{BACKEND_IMAGE_DIGEST\}"/,
  );
  assert.doesNotMatch(job, /smoke-container\.sh .*:\$\{CI_COMMIT_SHA\}/);
  assert.match(
    job,
    /^  artifacts:\n    paths:\n      - backend-image\.env\n    reports:\n      dotenv: backend-image\.env\n    expire_in: 7 days$/m,
  );
});

test("deploy requires the publication dotenv artifact and keeps aws-lab scope", () => {
  const job = topLevelBlock("deploy_backend_ecs");
  assert.match(
    job,
    /needs:\n\s+- job: publish_backend_image\n\s+artifacts: true/,
  );
  assert.match(job, /^  tags:\n    - inteli-gitlab-runner-prd$/m);
  assert.match(job, /environment:\n\s+name: aws-lab/);
  assert.doesNotMatch(job, /validate_backend_container/);
});

test("portable ignore policy excludes all Superpowers workflow artifacts", () => {
  assert.match(gitignore, /^\/docs\/superpowers\/$/m);
  assert.match(gitignore, /^\/\.superpowers\/$/m);
});

test("deployment guide documents the institutional runner and temporary unprotected-develop renewal", () => {
  assert.match(deployReadme, /runner compartilhado/i);
  assert.match(deployReadme, /inteli-gitlab-runner-prd/);
  assert.doesNotMatch(
    deployReadme,
    /backend-(docker-ephemeral|deploy-protected)/,
  );
  assert.match(
    deployReadme,
    /scripts\/sync-aws-gitlab-credentials\.sh --dry-run --allow-unprotected-develop/,
  );
  assert.match(
    deployReadme,
    /scripts\/sync-aws-gitlab-credentials\.sh --allow-unprotected-develop/,
  );
  assert.doesNotMatch(
    deployReadme,
    /aws configure export-credentials|printenv/i,
  );
});

test("every backend CI executor and Docker service uses a tag plus immutable digest", () => {
  assert.match(
    topLevelBlock("validate_backend"),
    /image: node:22\.22\.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94/,
  );
  for (const jobName of [
    "validate_backend_container",
    "publish_backend_image",
  ]) {
    const job = topLevelBlock(jobName);
    assert.match(
      job,
      /image: docker:27\.4\.1-cli@sha256:af0bcc63244e5110ac6499e4a9160a67101bf61abda35c2503ffc40038e8ee0a/,
    );
    assert.match(
      job,
      /name: docker:27\.4\.1-dind@sha256:3c8fb358b82767a38189e54a89a2ba8d71109f0a17efa87fd009ef8283c46df6/,
    );
  }
  assert.match(
    topLevelBlock("deploy_backend_ecs"),
    /image: alpine:3\.22\.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1/,
  );
  const backendPipeline = [
    "validate_backend",
    "validate_backend_container",
    "publish_backend_image",
    "deploy_backend_ecs",
  ]
    .map((jobName) => topLevelBlock(jobName))
    .join("\n");
  const executorRefs = executorReferences(backendPipeline);
  assert.ok(executorRefs.length > 0);
  for (const reference of executorRefs) {
    assert.match(reference, /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
  }
});

test("both Docker jobs pin the inner BuildKit driver image", () => {
  const pinnedBuildKit =
    "moby/buildkit:v0.18.2@sha256:86c0ad9d1137c186e9d455912167df20e530bdf7f7c19de802e892bb8ca16552";
  for (const jobName of [
    "validate_backend_container",
    "publish_backend_image",
  ]) {
    assert.match(
      topLevelBlock(jobName),
      new RegExp(
        `docker buildx create --name ci-builder --driver docker-container --driver-opt image=${pinnedBuildKit} --use`,
      ),
    );
  }
});

test("runtime-installed Alpine packages use compatible exact versions", () => {
  assert.match(
    topLevelBlock("validate_backend_container"),
    /apk add --no-cache bash=5\.2\.37-r0 jq=1\.7\.1-r0/,
  );
  assert.match(
    topLevelBlock("publish_backend_image"),
    /apk add --no-cache aws-cli=2\.22\.10-r0 bash=5\.2\.37-r0 git=2\.47\.3-r0 jq=1\.7\.1-r0/,
  );
  assert.match(
    topLevelBlock("deploy_backend_ecs"),
    /apk add --no-cache aws-cli=2\.27\.25-r0 bash=5\.2\.37-r0 curl=8\.14\.1-r3 git=2\.49\.1-r0 jq=1\.8\.1-r0/,
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipeline = fs.readFileSync(
  path.resolve(__dirname, "../../../../../.gitlab-ci.yml"),
  "utf8",
);

function topLevelBlock(name) {
  const start = pipeline.indexOf(`${name}:\n`);
  assert.notEqual(start, -1, `missing top-level block ${name}`);
  const remainder = pipeline.slice(start + name.length + 2);
  const next = remainder.search(/^\S[^\n]*:\n/m);
  return next === -1 ? remainder : remainder.slice(0, next);
}

test("pipeline conservatively cancels obsolete pre-deploy work", () => {
  assert.match(pipeline, /auto_cancel:\n\s+on_new_commit: conservative/);
  assert.doesNotMatch(pipeline, /on_new_commit: interruptible/);
  assert.match(topLevelBlock("deploy_backend_ecs"), /interruptible: false/);
  assert.match(topLevelBlock("deploy_backend_ecs"), /resource_group: monitoracao-api-service/);
});

test("backend changes exclude deploy documentation and snapshots", () => {
  const workflow = topLevelBlock("workflow");
  assert.match(workflow, /apps\/backend\/api\/src\/\*\*\/\*/);
  assert.match(workflow, /apps\/backend\/api\/tests\/\*\*\/\*/);
  assert.match(workflow, /apps\/backend\/api\/package\.json/);
  assert.match(workflow, /apps\/backend\/api\/package-lock\.json/);
  assert.match(workflow, /apps\/backend\/api\/Dockerfile/);
  assert.match(workflow, /apps\/backend\/api\/\.dockerignore/);
  assert.match(workflow, /scripts\/ci\/\*\*\/\*/);
  assert.doesNotMatch(workflow, /apps\/backend\/api\/\*\*\/\*/);
  assert.doesNotMatch(workflow, /apps\/backend\/api\/deploy/);
  assert.doesNotMatch(workflow, /docs\/superpowers/);
});

test("merge requests validate containers without protected AWS scope", () => {
  const job = topLevelBlock("validate_backend_container");
  assert.match(job, /tags:\n\s+- backend-docker-ephemeral/);
  assert.match(job, /CI_PIPELINE_SOURCE == "merge_request_event"/);
  assert.doesNotMatch(job, /CI_PIPELINE_SOURCE == "push"/);
  assert.doesNotMatch(job, /environment:/);
  assert.doesNotMatch(job, /aws |AWS_ACCESS_KEY_ID|publish-backend-image/);
});

test("develop publication is protected, digest-producing, and isolated from MR rules", () => {
  const job = topLevelBlock("publish_backend_image");
  assert.match(job, /tags:\n\s+- backend-docker-ephemeral/);
  assert.match(job, /CI_PIPELINE_SOURCE == "push"/);
  assert.doesNotMatch(job, /merge_request_event/);
  assert.match(job, /environment:\n\s+name: aws-lab\n\s+action: prepare/);
  assert.match(job, /bash scripts\/ci\/publish-backend-image\.sh/);
  assert.match(job, /\. backend-image\.env/);
  assert.match(job, /smoke-container\.sh "\$\{AWS_ACCOUNT_ID\}.*@\$\{BACKEND_IMAGE_DIGEST\}"/);
  assert.doesNotMatch(job, /smoke-container\.sh .*:\$\{CI_COMMIT_SHA\}/);
  assert.match(job, /reports:\n\s+dotenv: backend-image\.env/);
});

test("deploy requires the publication dotenv artifact and keeps aws-lab scope", () => {
  const job = topLevelBlock("deploy_backend_ecs");
  assert.match(job, /needs:\n\s+- job: publish_backend_image\n\s+artifacts: true/);
  assert.match(job, /environment:\n\s+name: aws-lab/);
  assert.doesNotMatch(job, /validate_backend_container/);
});

test("every CI executor and Docker service uses a tag plus immutable digest", () => {
  assert.match(
    topLevelBlock("validate_backend"),
    /image: node:22\.22\.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94/,
  );
  for (const jobName of ["validate_backend_container", "publish_backend_image"]) {
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
  const executorRefs = [
    ...[...pipeline.matchAll(/^\s+image:\s+(\S+)$/gm)].map((match) => match[1]),
    ...[...pipeline.matchAll(/^\s+- name:\s+(docker:\S+)$/gm)].map((match) => match[1]),
  ];
  assert.equal(executorRefs.length, 6);
  for (const reference of executorRefs) {
    assert.match(reference, /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
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

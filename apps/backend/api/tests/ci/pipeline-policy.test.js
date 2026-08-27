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
  assert.match(job, /environment:\n\s+name: aws-lab/);
  assert.match(job, /bash scripts\/ci\/publish-backend-image\.sh/);
  assert.match(job, /reports:\n\s+dotenv: backend-image\.env/);
});

test("deploy requires the publication dotenv artifact and keeps aws-lab scope", () => {
  const job = topLevelBlock("deploy_backend_ecs");
  assert.match(job, /needs:\n\s+- job: publish_backend_image\n\s+artifacts: true/);
  assert.match(job, /environment:\n\s+name: aws-lab/);
  assert.doesNotMatch(job, /validate_backend_container/);
});

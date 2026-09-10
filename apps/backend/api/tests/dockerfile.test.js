const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");
const smokeHelper = fs.readFileSync(
  path.resolve(__dirname, "../../../../scripts/ci/smoke-container.sh"),
  "utf8",
);
const liveE2eHelperPath = path.resolve(
  __dirname,
  "../../../../scripts/ci/test-live-api-local.sh",
);

test("Dockerfile defines a reproducible non-root Node 22 runtime", () => {
  assert.match(
    dockerfile,
    /^# syntax=docker\/dockerfile:1\.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e$/m,
  );
  assert.match(
    dockerfile,
    /^FROM node:22\.22\.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime$/m,
  );
  assert.match(dockerfile, /apt-get install -y --no-install-recommends dumb-init=1\.2\.5-2/);
  assert.doesNotMatch(dockerfile, /apt-get install -y --no-install-recommends dumb-init(?:\s|\\)/);
  assert.match(dockerfile, /^FROM node:22\.22\.0-bookworm-slim@sha256:[a-f0-9]{64} AS build$/m);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /npm run build && npm prune --omit=dev/);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /^ENTRYPOINT \["dumb-init", "--"\]$/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/index\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
});

test("smoke helper requires an exact HTTP 200 health response", () => {
  assert.match(smokeHelper, /response\.status\s*!==\s*200/);
  assert.doesNotMatch(smokeHelper, /response\.ok/);
});

test("smoke helper supplies every secret required to bootstrap the API", () => {
  assert.match(smokeHelper, /--env AUTH_COOKIE_SECRET=/);
  assert.match(smokeHelper, /--env CURSOR_SECRET=/);
});

test("live E2E helper pins DynamoDB Local and guarantees container cleanup", () => {
  assert.equal(
    fs.existsSync(liveE2eHelperPath),
    true,
    "the DynamoDB Local E2E runner must exist",
  );
  const helper = fs.readFileSync(liveE2eHelperPath, "utf8");
  const images = helper.match(/amazon\/dynamodb-local:[^\s"']+/g) ?? [];
  assert.deepEqual(images, [
    "amazon/dynamodb-local:2.6.1@sha256:990211fe3cbb507c52512522b5e71538802f086393f5b0d009d03a18c8bc04a6",
  ]);
  assert.match(helper, /cleanup\(\)\s*\{[\s\S]*docker rm -f/);
  assert.match(helper, /^trap cleanup EXIT$/m);
});

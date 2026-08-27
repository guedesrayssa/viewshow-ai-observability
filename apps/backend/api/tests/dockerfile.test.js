const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");
const smokeHelper = fs.readFileSync(
  path.resolve(__dirname, "../../../../scripts/ci/smoke-container.sh"),
  "utf8",
);

test("Dockerfile defines a reproducible non-root Node 22 runtime", () => {
  assert.match(dockerfile, /^FROM node:22\.22\.0-bookworm-slim AS runtime$/m);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /^ENTRYPOINT \["dumb-init", "--"\]$/m);
  assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
});

test("smoke helper requires an exact HTTP 200 health response", () => {
  assert.match(smokeHelper, /response\.status\s*!==\s*200/);
  assert.doesNotMatch(smokeHelper, /response\.ok/);
});

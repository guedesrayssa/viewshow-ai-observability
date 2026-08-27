const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/ci/render-task-definition.sh");

function taskDefinition(containers) {
  return {
    taskDefinitionArn: "arn:old",
    revision: 1,
    status: "ACTIVE",
    requiresAttributes: [],
    compatibilities: ["EC2", "FARGATE"],
    registeredAt: "2026-08-25T00:00:00Z",
    registeredBy: "arn:registrar",
    family: "monitoracao-api-task",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    containerDefinitions: containers,
  };
}

function render(containers) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-render-"));
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "output.json");
  fs.writeFileSync(input, JSON.stringify(taskDefinition(containers)));
  const result = spawnSync(
    script,
    [input, output, "example.invalid/monitoracao-api:abc123", "monitoracao-api-container"],
    { encoding: "utf8" },
  );
  return { result, output };
}

test("renderer changes only the target image and removes response fields", () => {
  const { result, output } = render([
    { name: "monitoracao-api-container", image: "old:v1", environment: [{ name: "KEEP", value: "yes" }] },
    { name: "sidecar", image: "sidecar:v1" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  const rendered = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(rendered.taskDefinitionArn, undefined);
  assert.equal(rendered.revision, undefined);
  assert.equal(rendered.status, undefined);
  assert.equal(rendered.registeredAt, undefined);
  assert.equal(rendered.containerDefinitions[0].image, "example.invalid/monitoracao-api:abc123");
  assert.deepEqual(rendered.containerDefinitions[0].environment, [{ name: "KEEP", value: "yes" }]);
  assert.equal(rendered.containerDefinitions[0].healthCheck.command[0], "CMD-SHELL");
  assert.equal(rendered.containerDefinitions[1].image, "sidecar:v1");
});

test("renderer rejects a missing target container", () => {
  const { result } = render([{ name: "sidecar", image: "sidecar:v1" }]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one container/);
});

test("renderer rejects duplicate target containers", () => {
  const target = { name: "monitoracao-api-container", image: "old:v1" };
  const { result } = render([target, target]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one container/);
});

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
    deleteRequestedAt: "2026-08-27T12:00:00Z",
    family: "monitoracao-api-task",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    taskRoleArn: "arn:aws:iam::248880318395:role/TaskRole",
    executionRoleArn: "arn:aws:iam::248880318395:role/ExecutionRole",
    volumes: [{ name: "shared", host: {} }],
    placementConstraints: [],
    proxyConfiguration: {
      type: "APPMESH",
      containerName: "envoy",
      properties: [{ name: "IgnoredUID", value: "1337" }],
    },
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    ephemeralStorage: { sizeInGiB: 30 },
    enableFaultInjection: false,
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
  assert.equal(rendered.deleteRequestedAt, undefined);
  assert.equal(rendered.containerDefinitions[0].image, "example.invalid/monitoracao-api:abc123");
  assert.deepEqual(rendered.containerDefinitions[0].environment, [{ name: "KEEP", value: "yes" }]);
  assert.equal(rendered.containerDefinitions[0].healthCheck.command[0], "CMD-SHELL");
  assert.equal(rendered.containerDefinitions[1].image, "sidecar:v1");
});

test("renderer deep-preserves a realistic registration payload except target runtime fields", () => {
  const target = {
    name: "monitoracao-api-container",
    image: "old:v1",
    essential: true,
    cpu: 128,
    memoryReservation: 384,
    portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp", name: "http" }],
    environment: [{ name: "KEEP", value: "yes" }],
    secrets: [{ name: "SECRET", valueFrom: "arn:secret" }],
    mountPoints: [{ sourceVolume: "shared", containerPath: "/shared", readOnly: false }],
    logConfiguration: {
      logDriver: "awslogs",
      options: { "awslogs-group": "/ecs/monitoracao-api", "awslogs-region": "us-east-1" },
    },
    linuxParameters: { initProcessEnabled: true },
    healthCheck: { command: ["CMD-SHELL", "old"], interval: 5, timeout: 2, retries: 1 },
  };
  const sidecar = {
    name: "envoy",
    image: "public.ecr.aws/example/envoy@sha256:deadbeef",
    essential: false,
    environment: [{ name: "UNCHANGED", value: "true" }],
  };
  const input = taskDefinition([target, sidecar]);
  const expected = structuredClone(input);
  for (const key of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
    "deleteRequestedAt",
  ]) delete expected[key];
  expected.containerDefinitions[0].image = "example.invalid/monitoracao-api:abc123";
  expected.containerDefinitions[0].healthCheck = {
    command: [
      "CMD-SHELL",
      "node -e \"const http=require('node:http');const request=http.get('http://127.0.0.1:3000/health',response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.setTimeout(4000,()=>{request.destroy();process.exit(1)})\"",
    ],
    interval: 30,
    timeout: 5,
    retries: 3,
    startPeriod: 10,
  };

  const { result, output } = render([target, sidecar]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), expected);
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

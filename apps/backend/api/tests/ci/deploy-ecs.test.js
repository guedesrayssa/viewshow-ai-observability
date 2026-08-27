const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/ci/deploy-ecs.sh");
const oldArn = "arn:aws:ecs:us-east-1:248880318395:task-definition/monitoracao-api-task:1";
const newArn = "arn:aws:ecs:us-east-1:248880318395:task-definition/monitoracao-api-task:2";
const albArn = "arn:aws:elasticloadbalancing:us-east-1:248880318395:loadbalancer/app/data-ingestion-alb/456";
const commitSha = "abc123def456abc123def456abc123def456abcd";

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runDeploy({
  failSmoke = false,
  passRoleDecision = "allowed",
  failConfirmation = false,
  failUpdateAfterMutation = false,
  failRollbackUpdate = false,
  terminateDuringWait = false,
  smokeAttempts = "1",
  smokeDelaySeconds = "0",
  httpStatus = "200",
  healthBody = '{"status":"ok"}',
  targetGroupAlbArn = albArn,
  stdoutToDevFull = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecs-deploy-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const task = path.join(directory, "task.json");
  const state = path.join(directory, "current-task.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(state, oldArn);
  fs.writeFileSync(
    task,
    JSON.stringify({
      taskDefinitionArn: oldArn,
      revision: 1,
      status: "ACTIVE",
      family: "monitoracao-api-task",
      taskRoleArn: "arn:aws:iam::248880318395:role/LabRole",
      executionRoleArn: "arn:aws:iam::248880318395:role/LabRole",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      containerDefinitions: [{ name: "monitoracao-api-container", image: "old:v1" }],
    }),
  );

  writeExecutable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws:%s\\n' "$*" >>"$CALL_LOG"
case "$*" in
  *"sts get-caller-identity"*) echo '{"Account":"248880318395","Arn":"arn:aws:sts::248880318395:assumed-role/voclabs/test-session"}' ;;
  *"ecr describe-images"*) echo 'sha256:testdigest' ;;
  *"ecs describe-services"*"taskDefinition"*)
    if [[ "$FAIL_CONFIRMATION" == "true" && "$(cat "$STATE_FILE")" == "$NEW_ARN" ]]; then exit 3; fi
    cat "$STATE_FILE"
    ;;
  *"ecs describe-services"*)
    [[ "$*" == *"--output json"* ]] || { echo "describe-services must request JSON" >&2; exit 11; }
    current_task="$(cat "$STATE_FILE")"
    printf '{"status":"ACTIVE","taskDefinition":"%s","deploymentController":{"type":"ECS"},"loadBalancers":[{"targetGroupArn":"arn:aws:elasticloadbalancing:us-east-1:248880318395:targetgroup/api/123","containerName":"monitoracao-api-container"}]}\\n' "$current_task"
    ;;
  *"ecs describe-task-definition"*)
    [[ "$*" == *"--output json"* ]] || { echo "describe-task-definition must request JSON" >&2; exit 12; }
    cat "$TASK_FIXTURE"
    ;;
  *"iam simulate-principal-policy"*) echo "$PASS_ROLE_DECISION" ;;
  *"elbv2 describe-target-groups"*)
    printf '{"TargetGroupArn":"arn:aws:elasticloadbalancing:us-east-1:248880318395:targetgroup/api/123","LoadBalancerArns":["%s"]}\\n' "$TARGET_GROUP_ALB_ARN"
    ;;
  *"elbv2 describe-load-balancers"*)
    printf '{"LoadBalancerArn":"%s","DNSName":"alb.example.test"}\\n' "$ALB_ARN"
    ;;
  *"ecs register-task-definition"*)
    arguments=("$@")
    input_json=""
    for ((index = 0; index < \${#arguments[@]}; index += 1)); do
      if [[ "\${arguments[$index]}" == "--cli-input-json" ]]; then
        input_json="\${arguments[$((index + 1))]#file://}"
      fi
    done
    jq -e --arg image "$EXPECTED_IMAGE" --arg container "$EXPECTED_CONTAINER" '
      .family == "monitoracao-api-task"
      and ([.containerDefinitions[] | select(.name == $container and .image == $image and .healthCheck.command[0] == "CMD-SHELL")] | length == 1)
    ' "$input_json" >/dev/null
    echo "$NEW_ARN"
    ;;
  *"ecs update-service"*)
    arguments=("$@")
    task_definition=""
    for ((index = 0; index < \${#arguments[@]}; index += 1)); do
      if [[ "\${arguments[$index]}" == "--task-definition" ]]; then
        task_definition="\${arguments[$((index + 1))]}"
      fi
    done
    if [[ "$FAIL_ROLLBACK_UPDATE" == "true" && "$task_definition" == "$OLD_ARN" ]]; then exit 5; fi
    printf '%s' "$task_definition" >"$STATE_FILE"
    if [[ "$FAIL_UPDATE_AFTER_MUTATION" == "true" && "$task_definition" == "$NEW_ARN" ]]; then exit 4; fi
    if [[ "$task_definition" == "$NEW_ARN" && "$*" != *"deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100"* ]]; then exit 13; fi
    echo '{}'
    ;;
  *"ecs wait services-stable"*)
    if [[ "$TERMINATE_DURING_WAIT" == "true" && "$(cat "$STATE_FILE")" == "$NEW_ARN" ]]; then
      kill -TERM "$PPID"
    fi
    exit 0
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 2 ;;
esac
`,
  );

  writeExecutable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'curl:%s\\n' "$*" >>"$CALL_LOG"
if [[ "$FAIL_SMOKE" == "true" ]]; then exit 22; fi
if [[ "$*" == *"--write-out"* ]]; then
  printf '%s\\n%s' "$HEALTH_BODY" "$HTTP_STATUS"
else
  printf '%s\\n' "$HEALTH_BODY"
fi
`,
  );

  const spawnOptions = {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      TASK_FIXTURE: task,
      STATE_FILE: state,
      OLD_ARN: oldArn,
      NEW_ARN: newArn,
      PASS_ROLE_DECISION: passRoleDecision,
      FAIL_SMOKE: String(failSmoke),
      FAIL_CONFIRMATION: String(failConfirmation),
      FAIL_UPDATE_AFTER_MUTATION: String(failUpdateAfterMutation),
      FAIL_ROLLBACK_UPDATE: String(failRollbackUpdate),
      TERMINATE_DURING_WAIT: String(terminateDuringWait),
      SMOKE_ATTEMPTS: smokeAttempts,
      SMOKE_DELAY_SECONDS: smokeDelaySeconds,
      HTTP_STATUS: httpStatus,
      HEALTH_BODY: healthBody,
      ALB_ARN: albArn,
      TARGET_GROUP_ALB_ARN: targetGroupAlbArn,
      EXPECTED_IMAGE: `248880318395.dkr.ecr.us-east-1.amazonaws.com/monitoracao-api:${commitSha}`,
      EXPECTED_CONTAINER: "monitoracao-api-container",
      AWS_ACCOUNT_ID: "248880318395",
      AWS_DEFAULT_REGION: "us-east-1",
      ECR_REPOSITORY: "monitoracao-api",
      ECS_CLUSTER: "data-ingestion-cluster",
      ECS_SERVICE: "monitoracao-api-service",
      ECS_TASK_FAMILY: "monitoracao-api-task",
      ECS_CONTAINER_NAME: "monitoracao-api-container",
      ALB_NAME: "data-ingestion-alb",
      CI_COMMIT_SHA: commitSha,
    },
  };
  let stdoutDescriptor;
  if (stdoutToDevFull) {
    stdoutDescriptor = fs.openSync("/dev/full", "w");
    spawnOptions.stdio = ["ignore", stdoutDescriptor, "pipe"];
  }
  const result = spawnSync(script, [], spawnOptions);
  if (stdoutDescriptor !== undefined) fs.closeSync(stdoutDescriptor);

  const deployment = {
    result,
    calls: fs.readFileSync(calls, "utf8"),
    state: fs.readFileSync(state, "utf8"),
  };
  fs.rmSync(directory, { recursive: true });
  return deployment;
}

test("successful deploy updates ECS once and keeps the new revision", () => {
  const { result, calls } = runDeploy();
  assert.equal(result.status, 0, result.stderr);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 1);
  assert.match(updates[0], new RegExp(newArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(updates[0], /deploymentCircuitBreaker=\{enable=true,rollback=true\},maximumPercent=200,minimumHealthyPercent=100/);
  assert.match(result.stdout, /deployment healthy/);
  assert.match(result.stdout, new RegExp(commitSha));
});

test("failed public smoke restores and confirms the previous task definition", () => {
  const { result, calls, state } = runDeploy({ failSmoke: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  const confirmations = calls
    .split("\n")
    .filter((line) => line.includes("ecs describe-services") && line.includes("taskDefinition"));
  assert.equal(updates.length, 2);
  assert.equal(confirmations.length, 2);
  assert.match(updates[0], new RegExp(newArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(updates[1], new RegExp(oldArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(state, oldArn);
  assert.match(result.stderr, /restoring previous task definition/);
});

test("non-200 public health response restores the previous task definition", () => {
  const { result, calls, state } = runDeploy({ httpStatus: "201" });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, oldArn);
});

test("wrong public health JSON restores the previous task definition", () => {
  const { result, calls, state } = runDeploy({ healthBody: '{"status":"ok","extra":true}' });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, oldArn);
});

test("target group attached to another ALB fails before ECS mutation", () => {
  const { result, calls } = runDeploy({
    targetGroupAlbArn: "arn:aws:elasticloadbalancing:us-east-1:248880318395:loadbalancer/app/other/789",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target group is not attached to ALB/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("failed post-update confirmation restores the previous task definition once", () => {
  const { result, calls } = runDeploy({ failConfirmation: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.match(updates[0], new RegExp(newArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(updates[1], new RegExp(oldArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, /restoring previous task definition/);
});

test("ambiguous update failure restores the previous task definition", () => {
  const { result, calls } = runDeploy({ failUpdateAfterMutation: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.match(updates[0], new RegExp(newArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(updates[1], new RegExp(oldArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, /restoring previous task definition/);
});

test("rollback failure is reported without hiding the original failure", () => {
  const { result, calls, state } = runDeploy({ failSmoke: true, failRollbackUpdate: true });
  assert.equal(result.status, 1);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, newArn);
  assert.match(result.stderr, /rollback could not be confirmed/);
});

test("final output failure restores the previous task definition", () => {
  const { result, calls, state } = runDeploy({ stdoutToDevFull: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, oldArn);
});

test("termination during stabilization restores the previous task definition", () => {
  const { result, calls, state } = runDeploy({ terminateDuringWait: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, oldArn);
});

test("invalid smoke configuration fails before registering or updating ECS", () => {
  const { result, calls } = runDeploy({ smokeAttempts: "bogus" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SMOKE_ATTEMPTS must be a positive integer/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("denied iam:PassRole fails before registering or updating ECS", () => {
  const { result, calls } = runDeploy({ passRoleDecision: "implicitDeny" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /iam:PassRole is not allowed/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

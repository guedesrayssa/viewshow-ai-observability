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
  longRunningWaiter = false,
  smokeAttempts = "1",
  smokeDelaySeconds = "0",
  httpStatus = "200",
  healthBody = '{"status":"ok"}',
  targetGroupAlbArn = albArn,
  stdoutToDevFull = false,
  envOverrides = {},
  missingCommand = null,
  imageDigest = "sha256:testdigest",
  serviceStatus = "ACTIVE",
  controllerType = "ECS",
  taskFamily = "monitoracao-api-task",
  containerMode = "correct",
  resolveTargetGroup = true,
  resolveAlb = true,
  actualAccount = "248880318395",
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecs-deploy-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const task = path.join(directory, "task.json");
  const state = path.join(directory, "current-task.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(state, oldArn);
  const targetContainer = { name: "monitoracao-api-container", image: "old:v1" };
  const containerDefinitions = {
    correct: [targetContainer],
    missing: [{ name: "sidecar", image: "sidecar:v1" }],
    duplicate: [targetContainer, targetContainer],
  }[containerMode];
  assert.ok(containerDefinitions, `unknown container mode ${containerMode}`);
  fs.writeFileSync(
    task,
    JSON.stringify({
      taskDefinitionArn: oldArn,
      revision: 1,
      status: "ACTIVE",
      family: taskFamily,
      taskRoleArn: "arn:aws:iam::248880318395:role/TaskRole",
      executionRoleArn: "arn:aws:iam::248880318395:role/ExecutionRole",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      containerDefinitions,
    }),
  );

  if (missingCommand !== "aws") {
    writeExecutable(
      path.join(bin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
call="$*"
printf 'aws:%s\\n' "$call" >>"$CALL_LOG"
if [[ "$call" == "sts get-caller-identity --output json" ]]; then
  printf '{"Account":"%s","Arn":"arn:aws:sts::%s:assumed-role/voclabs/test-session"}\\n' "$ACTUAL_ACCOUNT" "$ACTUAL_ACCOUNT"
elif [[ "$call" == "ecs describe-services --region us-east-1 --cluster data-ingestion-cluster --services monitoracao-api-service --query services[0] --output json" ]]; then
  current_task="$(cat "$STATE_FILE")"
  printf '{"status":"%s","taskDefinition":"%s","deploymentController":{"type":"%s"},"loadBalancers":[{"targetGroupArn":"arn:aws:elasticloadbalancing:us-east-1:248880318395:targetgroup/api/123","containerName":"monitoracao-api-container"}]}\\n' "$SERVICE_STATUS" "$current_task" "$CONTROLLER_TYPE"
elif [[ "$call" == "ecr describe-images --region us-east-1 --repository-name monitoracao-api --image-ids imageTag=$EXPECTED_SHA --query imageDetails[0].imageDigest --output text" ]]; then
  echo "$IMAGE_DIGEST"
elif [[ "$call" == "ecs describe-task-definition --region us-east-1 --task-definition $OLD_ARN --query taskDefinition --output json" ]]; then
  cat "$TASK_FIXTURE"
elif [[ "$call" == "elbv2 describe-target-groups --region us-east-1 --target-group-arns arn:aws:elasticloadbalancing:us-east-1:248880318395:targetgroup/api/123 --query TargetGroups[0] --output json" ]]; then
  if [[ "$RESOLVE_TARGET_GROUP" == "true" ]]; then
    printf '{"TargetGroupArn":"arn:aws:elasticloadbalancing:us-east-1:248880318395:targetgroup/api/123","LoadBalancerArns":["%s"]}\\n' "$TARGET_GROUP_ALB_ARN"
  else
    echo '{"TargetGroupArn":null,"LoadBalancerArns":[]}'
  fi
elif [[ "$call" == "elbv2 describe-load-balancers --region us-east-1 --names data-ingestion-alb --query LoadBalancers[0] --output json" ]]; then
  if [[ "$RESOLVE_ALB" == "true" ]]; then
    printf '{"LoadBalancerArn":"%s","DNSName":"alb.example.test"}\\n' "$ALB_ARN"
  else
    echo '{"LoadBalancerArn":null,"DNSName":null}'
  fi
elif [[ "$call" == "iam simulate-principal-policy --policy-source-arn arn:aws:iam::248880318395:role/voclabs --action-names iam:PassRole --resource-arns arn:aws:iam::248880318395:role/TaskRole --query EvaluationResults[0].EvalDecision --output text" \
  || "$call" == "iam simulate-principal-policy --policy-source-arn arn:aws:iam::248880318395:role/voclabs --action-names iam:PassRole --resource-arns arn:aws:iam::248880318395:role/ExecutionRole --query EvaluationResults[0].EvalDecision --output text" ]]; then
  echo "$PASS_ROLE_DECISION"
elif [[ "$call" == "ecs describe-services --region us-east-1 --cluster data-ingestion-cluster --services monitoracao-api-service --query services[0].taskDefinition --output text" ]]; then
    if [[ "$FAIL_CONFIRMATION" == "true" && "$(cat "$STATE_FILE")" == "$NEW_ARN" ]]; then exit 3; fi
    cat "$STATE_FILE"
elif [[ "$1" == "ecs" && "$2" == "register-task-definition" ]]; then
    [[ "$#" -eq 10 && "$3" == "--region" && "$4" == "us-east-1" \
      && "$5" == "--cli-input-json" && "$6" == file://* \
      && "$7" == "--query" && "$8" == "taskDefinition.taskDefinitionArn" \
      && "$9" == "--output" && "\${10}" == "text" ]] \
      || { echo "unexpected register arguments: $call" >&2; exit 2; }
    input_json="\${6#file://}"
    jq -e --arg image "$EXPECTED_IMAGE" --arg container "$EXPECTED_CONTAINER" '
      .family == "monitoracao-api-task"
      and ([.containerDefinitions[] | select(.name == $container and .image == $image and .healthCheck.command[0] == "CMD-SHELL")] | length == 1)
    ' "$input_json" >/dev/null
    echo "$NEW_ARN"
elif [[ "$call" == "ecs update-service --region us-east-1 --cluster data-ingestion-cluster --service monitoracao-api-service --task-definition $NEW_ARN --deployment-configuration deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" ]]; then
    task_definition="$NEW_ARN"
    printf '%s' "$task_definition" >"$STATE_FILE"
    if [[ "$FAIL_UPDATE_AFTER_MUTATION" == "true" ]]; then exit 4; fi
    echo '{}'
elif [[ "$call" == "ecs update-service --region us-east-1 --cluster data-ingestion-cluster --service monitoracao-api-service --task-definition $OLD_ARN" ]]; then
    task_definition="$OLD_ARN"
    if [[ "$FAIL_ROLLBACK_UPDATE" == "true" && "$task_definition" == "$OLD_ARN" ]]; then exit 5; fi
    printf '%s' "$task_definition" >"$STATE_FILE"
    echo '{}'
elif [[ "$call" == "ecs wait services-stable --region us-east-1 --cluster data-ingestion-cluster --services monitoracao-api-service" ]]; then
    if [[ "$LONG_RUNNING_WAITER" == "true" && "$(cat "$STATE_FILE")" == "$NEW_ARN" ]]; then
      (
        watchdog_deadline=$((SECONDS + 2))
        while ((SECONDS < watchdog_deadline)); do :; done
        kill -TERM "$$"
      ) &
      watchdog_pid="$!"
      trap 'kill "$watchdog_pid" 2>/dev/null || true; exit 0' TERM
      kill -TERM "$PPID"
      while true; do sleep 0.1; done
    fi
    exit 0
else
  echo "unexpected aws call: $call" >&2
  exit 2
fi
`,
    );
  }

  if (missingCommand !== "curl") {
    writeExecutable(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'curl:'
  printf '%q ' "$@"
  printf '\\n'
} >>"$CALL_LOG"
expected_call=$'--fail --silent --show-error --max-time 10 --write-out \\n%{http_code} http://alb.example.test/health'
[[ "$*" == "$expected_call" ]] || { echo "unexpected curl call: $*" >&2; exit 2; }
if [[ "$FAIL_SMOKE" == "true" ]]; then exit 22; fi
printf '%s\\n%s' "$HEALTH_BODY" "$HTTP_STATUS"
`,
    );
  }

  let deployPath = `${bin}:${process.env.PATH}`;
  if (missingCommand) {
    const systemCommands = ["bash", "cat", "dirname", "jq", "mktemp", "mv", "rm", "sleep"];
    for (const command of systemCommands) {
      if (command === missingCommand) continue;
      const candidates = [`/usr/bin/${command}`, `/bin/${command}`];
      const target = candidates.find((candidate) => fs.existsSync(candidate));
      assert.ok(target, `test host is missing ${command}`);
      fs.symlinkSync(target, path.join(bin, command));
    }
    deployPath = bin;
  }

  const spawnOptions = {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: deployPath,
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
      LONG_RUNNING_WAITER: String(longRunningWaiter),
      SMOKE_ATTEMPTS: smokeAttempts,
      SMOKE_DELAY_SECONDS: smokeDelaySeconds,
      HTTP_STATUS: httpStatus,
      HEALTH_BODY: healthBody,
      ALB_ARN: albArn,
      TARGET_GROUP_ALB_ARN: targetGroupAlbArn,
      EXPECTED_IMAGE: `248880318395.dkr.ecr.us-east-1.amazonaws.com/monitoracao-api:${commitSha}`,
      EXPECTED_CONTAINER: "monitoracao-api-container",
      EXPECTED_SHA: commitSha,
      IMAGE_DIGEST: imageDigest,
      SERVICE_STATUS: serviceStatus,
      CONTROLLER_TYPE: controllerType,
      RESOLVE_TARGET_GROUP: String(resolveTargetGroup),
      RESOLVE_ALB: String(resolveAlb),
      ACTUAL_ACCOUNT: actualAccount,
      AWS_ACCOUNT_ID: "248880318395",
      AWS_DEFAULT_REGION: "us-east-1",
      ECR_REPOSITORY: "monitoracao-api",
      ECS_CLUSTER: "data-ingestion-cluster",
      ECS_SERVICE: "monitoracao-api-service",
      ECS_TASK_FAMILY: "monitoracao-api-task",
      ECS_CONTAINER_NAME: "monitoracao-api-container",
      ALB_NAME: "data-ingestion-alb",
      CI_COMMIT_SHA: commitSha,
      ...envOverrides,
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
  const passRoleCalls = calls.split("\n").filter((line) => line.includes("iam simulate-principal-policy"));
  assert.equal(passRoleCalls.length, 2);
  assert.match(passRoleCalls.join("\n"), /role\/TaskRole/);
  assert.match(passRoleCalls.join("\n"), /role\/ExecutionRole/);
  const operations = calls
    .trim()
    .split("\n")
    .map((line) => {
      if (line.startsWith("curl:")) return "curl";
      if (line.includes("sts get-caller-identity")) return "identity";
      if (line.includes("ecs describe-services") && line.includes("--output json")) return "service";
      if (line.includes("ecr describe-images")) return "image";
      if (line.includes("ecs describe-task-definition")) return "task";
      if (line.includes("elbv2 describe-target-groups")) return "target-group";
      if (line.includes("elbv2 describe-load-balancers")) return "alb";
      if (line.includes("iam simulate-principal-policy")) return "pass-role";
      if (line.includes("ecs register-task-definition")) return "register";
      if (line.includes("ecs update-service")) return "update";
      if (line.includes("ecs wait services-stable")) return "wait";
      if (line.includes("ecs describe-services") && line.includes("--output text")) return "confirm";
      return "unexpected";
    });
  assert.deepEqual(operations, [
    "identity",
    "service",
    "image",
    "task",
    "target-group",
    "alb",
    "pass-role",
    "pass-role",
    "register",
    "update",
    "wait",
    "confirm",
    "curl",
  ]);
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

test("multiple public health JSON documents restore the previous task definition", () => {
  const { result, calls, state } = runDeploy({ healthBody: '{"status":"bad"}\n{"status":"ok"}' });
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

test("termination during a long stabilization wait promptly restores the previous task definition", () => {
  const startedAt = Date.now();
  const { result, calls, state } = runDeploy({ longRunningWaiter: true });
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  assert.equal(updates.length, 2);
  assert.equal(state, oldArn);
  assert.ok(elapsedMilliseconds < 1000, `rollback took ${elapsedMilliseconds}ms`);
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

test("wrong STS account stops after identity lookup without ECS mutation", () => {
  const { result, calls } = runDeploy({ actualAccount: "000000000000" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS account: 000000000000/);
  assert.deepEqual(calls.trim().split("\n"), ["aws:sts get-caller-identity --output json"]);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

for (const [variable, value] of Object.entries({
  AWS_ACCOUNT_ID: "000000000000",
  AWS_DEFAULT_REGION: "us-west-2",
  ECR_REPOSITORY: "other-api",
  ECS_CLUSTER: "other-cluster",
  ECS_SERVICE: "other-service",
  ECS_TASK_FAMILY: "other-family",
  ECS_CONTAINER_NAME: "other-container",
  ALB_NAME: "other-alb",
  CI_COMMIT_SHA: "abc123def456",
})) {
  test(`wrong fixed binding ${variable} fails before any AWS call`, () => {
    const { result, calls } = runDeploy({ envOverrides: { [variable]: value } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected deployment binding|CI_COMMIT_SHA must be exactly 40 hexadecimal characters/);
    assert.equal(calls, "");
  });
}

for (const command of ["aws", "jq", "curl", "mktemp", "rm", "sleep", "dirname", "mv"]) {
  test(`missing ${command} fails before any AWS call`, () => {
    const { result, calls } = runDeploy({ missingCommand: command });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`required command is unavailable: ${command}`));
    assert.equal(calls, "");
  });
}

test("missing bash prevents execution before any AWS call", () => {
  const { result, calls } = runDeploy({ missingCommand: "bash" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bash/);
  assert.equal(calls, "");
});

test("cleanup trap is installed immediately after temporary directory creation", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(
    source,
    /temporary_directory="\$\(mktemp -d\)"\ntrap cleanup_temporary_directory EXIT/,
  );
});

for (const [name, options] of [
  ["missing image", { imageDigest: "None" }],
  ["inactive service", { serviceStatus: "INACTIVE" }],
  ["non-ECS deployment controller", { controllerType: "CODE_DEPLOY" }],
  ["wrong live family", { taskFamily: "other-family" }],
  ["missing live container", { containerMode: "missing" }],
  ["duplicate live container", { containerMode: "duplicate" }],
  ["unresolved target group", { resolveTargetGroup: false }],
  ["unresolved ALB", { resolveAlb: false }],
]) {
  test(`${name} fails before registering or updating ECS`, () => {
    const { result, calls } = runDeploy(options);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const script = path.join(repoRoot, "scripts/ci/deploy-ecs.sh");
const oldArn = "arn:aws:ecs:us-east-1:999999999999:task-definition/view-show-api-task:1";
const newArn = "arn:aws:ecs:us-east-1:999999999999:task-definition/view-show-api-task:2";
const albArn = "arn:aws:elasticloadbalancing:us-east-1:999999999999:loadbalancer/app/view-show-alb/456";
const listenerArn = `${albArn.replace("loadbalancer", "listener")}/listener-1`;
const commitSha = "abc123def456abc123def456abc123def456abcd";
const imageDigest = `sha256:${"b".repeat(64)}`;
const dockerImageMediaType = "application/vnd.docker.distribution.manifest.v2+json";
const ociImageMediaType = "application/vnd.oci.image.manifest.v1+json";
const ociIndexMediaType = "application/vnd.oci.image.index.v1+json";
const maxSignalCleanupMilliseconds = 5000;

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runDeploy({
  failSmoke = false,
  passRoleDecision = "allowed",
  failConfirmation = false,
  failUpdateAfterMutation = false,
  failRollbackUpdate = false,
  failForwardWaiter = false,
  longRunningWaiter = false,
  longRunningRollbackWaiter = false,
  smokeAttempts = "1",
  smokeDelaySeconds = "0",
  httpStatus = "200",
  healthBody = '{"status":"ok"}',
  targetGroupAlbArn = albArn,
  stdoutToDevFull = false,
  envOverrides = {},
  missingCommand = null,
  liveImageDigest = imageDigest,
  liveImageMediaType = dockerImageMediaType,
  expectedImageDigest = imageDigest,
  artifactContent = null,
  artifactSymlink = false,
  serviceStatus = "ACTIVE",
  controllerType = "ECS",
  taskFamily = "view-show-api-task",
  taskStatus = "ACTIVE",
  taskDeleteRequestedAt = null,
  lateTaskOverrides = {},
  runtimePlatform = null,
  containerMode = "correct",
  resolveTargetGroup = true,
  resolveAlb = true,
  actualAccount = "999999999999",
  callerArn = "arn:aws:sts::999999999999:assumed-role/voclabs/test-session",
  repositoryHead = commitSha,
  initialRemoteHead = commitSha,
  lateRemoteHead = commitSha,
  serviceOverrides = {},
  lateServiceOverrides = {},
  forwardStableOverrides = {},
  rollbackStableOverrides = {},
  albOverrides = {},
  listenerPort = 80,
  routeHealthToTargetGroup = true,
  rulesOverride = null,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecs-deploy-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls.log");
  const task = path.join(directory, "task.json");
  const lateTask = path.join(directory, "late-task.json");
  const service = path.join(directory, "service.json");
  const lateService = path.join(directory, "late-service.json");
  const forwardService = path.join(directory, "forward-service.json");
  const rollbackService = path.join(directory, "rollback-service.json");
  const alb = path.join(directory, "alb.json");
  const listeners = path.join(directory, "listeners.json");
  const rules = path.join(directory, "rules.json");
  const state = path.join(directory, "current-task.txt");
  const waiterCount = path.join(directory, "waiter-count.txt");
  const serviceReadCount = path.join(directory, "service-read-count.txt");
  const taskReadCount = path.join(directory, "task-read-count.txt");
  const remoteReadCount = path.join(directory, "remote-read-count.txt");
  const artifact = path.join(directory, "backend-image.env");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(state, oldArn);
  fs.writeFileSync(waiterCount, "0");
  fs.writeFileSync(serviceReadCount, "0");
  fs.writeFileSync(taskReadCount, "0");
  fs.writeFileSync(remoteReadCount, "0");
  if (artifactSymlink) {
    const artifactTarget = path.join(directory, "artifact-target.env");
    fs.writeFileSync(artifactTarget, artifactContent ?? `BACKEND_IMAGE_DIGEST=${expectedImageDigest}\n`);
    fs.symlinkSync(artifactTarget, artifact);
  } else {
    fs.writeFileSync(artifact, artifactContent ?? `BACKEND_IMAGE_DIGEST=${expectedImageDigest}\n`);
  }
  const targetContainer = { name: "view-show-api", image: "old:v1" };
  const containerDefinitions = {
    correct: [targetContainer],
    missing: [{ name: "sidecar", image: "sidecar:v1" }],
    duplicate: [targetContainer, targetContainer],
  }[containerMode];
  assert.ok(containerDefinitions, `unknown container mode ${containerMode}`);
  const taskFixture = {
    taskDefinitionArn: oldArn,
    revision: 1,
    status: taskStatus,
    family: taskFamily,
    taskRoleArn: "arn:aws:iam::999999999999:role/TaskRole",
    executionRoleArn: "arn:aws:iam::999999999999:role/ExecutionRole",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    containerDefinitions,
  };
  if (taskDeleteRequestedAt !== null) taskFixture.deleteRequestedAt = taskDeleteRequestedAt;
  if (runtimePlatform !== null) taskFixture.runtimePlatform = runtimePlatform;
  fs.writeFileSync(task, JSON.stringify(taskFixture));
  fs.writeFileSync(lateTask, JSON.stringify({ ...taskFixture, ...lateTaskOverrides }));
  const serviceFixture = {
    status: serviceStatus,
    taskDefinition: oldArn,
    deploymentController: { type: controllerType },
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200 },
    deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: oldArn }],
    loadBalancers: [{
      targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
      containerName: "view-show-api",
      containerPort: 3000,
    }],
    ...serviceOverrides,
  };
  fs.writeFileSync(service, JSON.stringify(serviceFixture));
  fs.writeFileSync(lateService, JSON.stringify({ ...serviceFixture, ...lateServiceOverrides }));
  fs.writeFileSync(forwardService, JSON.stringify({
    ...serviceFixture,
    taskDefinition: newArn,
    deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: newArn }],
    ...forwardStableOverrides,
  }));
  fs.writeFileSync(rollbackService, JSON.stringify({
    ...serviceFixture,
    taskDefinition: oldArn,
    deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: oldArn }],
    ...rollbackStableOverrides,
  }));
  fs.writeFileSync(
    alb,
    JSON.stringify(resolveAlb ? {
      LoadBalancerArn: albArn,
      DNSName: "alb.example.test",
      State: { Code: "active" },
      Type: "application",
      Scheme: "internet-facing",
      ...albOverrides,
    } : { LoadBalancerArn: null, DNSName: null }),
  );
  fs.writeFileSync(listeners, JSON.stringify([{ ListenerArn: listenerArn, Protocol: "HTTP", Port: listenerPort }]));
  fs.writeFileSync(
    rules,
    JSON.stringify(rulesOverride ?? (routeHealthToTargetGroup ? [{
      RuleArn: `${listenerArn}/rule-1`,
      Priority: "1",
      IsDefault: false,
      Conditions: [{ Field: "path-pattern", Values: ["/health"] }],
      Actions: [{
        Type: "forward",
        TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
      }],
    }] : [{
      RuleArn: `${listenerArn}/default`,
      Priority: "default",
      IsDefault: true,
      Conditions: [],
      Actions: [{
        Type: "forward",
        TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/other/999",
      }],
    }])),
  );

  if (missingCommand !== "git") {
    writeExecutable(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'git:%s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == "rev-parse --verify HEAD" ]]; then
  printf '%s\n' "$REPOSITORY_HEAD"
elif [[ "$*" == "ls-remote --exit-code origin refs/heads/develop" ]]; then
  remote_read_count=$(( $(cat "$REMOTE_READ_COUNT_FILE") + 1 ))
  printf '%s' "$remote_read_count" >"$REMOTE_READ_COUNT_FILE"
  if [[ "$remote_read_count" == "1" ]]; then
    remote_head="$INITIAL_REMOTE_HEAD"
  else
    remote_head="$LATE_REMOTE_HEAD"
  fi
  if [[ "$remote_head" == "__FAIL__" ]]; then
    echo "fixture network/auth failure for secret-bearing origin" >&2
    exit 128
  fi
  printf '%s\trefs/heads/develop\n' "$remote_head"
else
  echo "unexpected git call: $*" >&2
  exit 2
fi
`,
    );
  }

  if (missingCommand !== "aws") {
    writeExecutable(
      path.join(bin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "\${AWS_PAGER+x}:\${AWS_PAGER:-}" == "x:" ]] || { echo "pager-not-disabled" >&2; exit 91; }
[[ "\${AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:-}" == "true" ]] || { echo "endpoints-not-disabled" >&2; exit 92; }
call="$*"
printf 'aws:%s\\n' "$call" >>"$CALL_LOG"
if [[ "$call" == "sts get-caller-identity --output json" ]]; then
  printf '{"Account":"%s","Arn":"%s"}\\n' "$ACTUAL_ACCOUNT" "$CALLER_ARN"
elif [[ "$call" == "ecs describe-services --region us-east-1 --cluster view-show-cluster --services view-show-api-service --query services[0] --output json" ]]; then
  service_read_count=$(( $(cat "$SERVICE_READ_COUNT_FILE") + 1 ))
  printf '%s' "$service_read_count" >"$SERVICE_READ_COUNT_FILE"
  if [[ "$service_read_count" == "1" ]]; then
    cat "$SERVICE_FIXTURE"
  elif [[ "$service_read_count" == "2" ]]; then
    cat "$LATE_SERVICE_FIXTURE"
  elif [[ "$(cat "$STATE_FILE")" == "$NEW_ARN" ]]; then
    if [[ "$FAIL_CONFIRMATION" == "true" ]]; then exit 3; fi
    cat "$FORWARD_SERVICE_FIXTURE"
  else
    cat "$ROLLBACK_SERVICE_FIXTURE"
  fi
elif [[ "$call" == "ecr describe-images --region us-east-1 --repository-name view-show-api --image-ids imageTag=$EXPECTED_SHA --query imageDetails[0].{digest:imageDigest,mediaType:imageManifestMediaType} --output json" ]]; then
  printf '{"digest":"%s","mediaType":"%s"}\n' "$LIVE_IMAGE_DIGEST" "$LIVE_IMAGE_MEDIA_TYPE"
elif [[ "$call" == "ecs describe-task-definition --region us-east-1 --task-definition $OLD_ARN --query taskDefinition --output json" ]]; then
  task_read_count=$(( $(cat "$TASK_READ_COUNT_FILE") + 1 ))
  printf '%s' "$task_read_count" >"$TASK_READ_COUNT_FILE"
  if [[ "$task_read_count" == "1" ]]; then
    cat "$TASK_FIXTURE"
  else
    cat "$LATE_TASK_FIXTURE"
  fi
elif [[ "$call" == "elbv2 describe-target-groups --region us-east-1 --target-group-arns arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123 --query TargetGroups[0] --output json" ]]; then
  if [[ "$RESOLVE_TARGET_GROUP" == "true" ]]; then
    printf '{"TargetGroupArn":"arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123","LoadBalancerArns":["%s"]}\\n' "$TARGET_GROUP_ALB_ARN"
  else
    echo '{"TargetGroupArn":null,"LoadBalancerArns":[]}'
  fi
elif [[ "$call" == "elbv2 describe-load-balancers --region us-east-1 --names view-show-alb --query LoadBalancers[0] --output json" ]]; then
  cat "$ALB_FIXTURE"
elif [[ "$call" == "elbv2 describe-listeners --region us-east-1 --load-balancer-arn $ALB_ARN --query Listeners --output json" ]]; then
  cat "$LISTENERS_FIXTURE"
elif [[ "$call" == "elbv2 describe-rules --region us-east-1 --listener-arn $LISTENER_ARN --query Rules --output json" ]]; then
  cat "$RULES_FIXTURE"
elif [[ "$call" == "iam simulate-principal-policy --policy-source-arn arn:aws:iam::999999999999:role/voclabs --action-names iam:PassRole --resource-arns arn:aws:iam::999999999999:role/TaskRole --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string --query EvaluationResults[0].EvalDecision --output text" \
  || "$call" == "iam simulate-principal-policy --policy-source-arn arn:aws:iam::999999999999:role/voclabs --action-names iam:PassRole --resource-arns arn:aws:iam::999999999999:role/ExecutionRole --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string --query EvaluationResults[0].EvalDecision --output text" ]]; then
  echo "$PASS_ROLE_DECISION"
elif [[ "$1" == "ecs" && "$2" == "register-task-definition" ]]; then
    [[ "$#" -eq 10 && "$3" == "--region" && "$4" == "us-east-1" \
      && "$5" == "--cli-input-json" && "$6" == file://* \
      && "$7" == "--query" && "$8" == "taskDefinition.taskDefinitionArn" \
      && "$9" == "--output" && "\${10}" == "text" ]] \
      || { echo "unexpected register arguments: $call" >&2; exit 2; }
    input_json="\${6#file://}"
    jq -e --arg image "$EXPECTED_IMAGE" --arg container "$EXPECTED_CONTAINER" '
      .family == "view-show-api-task"
      and ([.containerDefinitions[] | select(.name == $container and .image == $image and .healthCheck.command[0] == "CMD-SHELL")] | length == 1)
    ' "$input_json" >/dev/null
    echo "$NEW_ARN"
elif [[ "$call" == "ecs update-service --region us-east-1 --cluster view-show-cluster --service view-show-api-service --task-definition $NEW_ARN --deployment-configuration deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" ]]; then
    task_definition="$NEW_ARN"
    printf '%s' "$task_definition" >"$STATE_FILE"
    if [[ "$FAIL_UPDATE_AFTER_MUTATION" == "true" ]]; then exit 4; fi
    echo '{}'
elif [[ "$call" == "ecs update-service --region us-east-1 --cluster view-show-cluster --service view-show-api-service --task-definition $OLD_ARN" ]]; then
    task_definition="$OLD_ARN"
    if [[ "$FAIL_ROLLBACK_UPDATE" == "true" && "$task_definition" == "$OLD_ARN" ]]; then exit 5; fi
    printf '%s' "$task_definition" >"$STATE_FILE"
    echo '{}'
elif [[ "$call" == "ecs wait services-stable --region us-east-1 --cluster view-show-cluster --services view-show-api-service" ]]; then
    waiter_count=$(( $(cat "$WAITER_COUNT_FILE") + 1 ))
    printf '%s' "$waiter_count" >"$WAITER_COUNT_FILE"
    if [[ "$FAIL_FORWARD_WAITER" == "true" && "$waiter_count" == "2" ]]; then
      exit 42
    fi
    if [[ ("$LONG_RUNNING_WAITER" == "true" && "$waiter_count" == "2") \
      || ("$LONG_RUNNING_ROLLBACK_WAITER" == "true" && "$waiter_count" == "3") ]]; then
      trap '' TERM
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
    const systemCommands = ["bash", "cat", "dirname", "git", "jq", "mktemp", "mv", "rm", "sleep"];
    for (const command of systemCommands) {
      if (command === missingCommand) continue;
      if (fs.existsSync(path.join(bin, command))) continue;
      const candidates = [`/usr/bin/${command}`, `/bin/${command}`];
      const target = candidates.find((candidate) => fs.existsSync(candidate));
      assert.ok(target, `test host is missing ${command}`);
      fs.symlinkSync(target, path.join(bin, command));
    }
    deployPath = bin;
  }

  const spawnOptions = {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: deployPath,
      CALL_LOG: calls,
      TASK_FIXTURE: task,
      LATE_TASK_FIXTURE: lateTask,
      SERVICE_FIXTURE: service,
      LATE_SERVICE_FIXTURE: lateService,
      FORWARD_SERVICE_FIXTURE: forwardService,
      ROLLBACK_SERVICE_FIXTURE: rollbackService,
      ALB_FIXTURE: alb,
      LISTENERS_FIXTURE: listeners,
      RULES_FIXTURE: rules,
      STATE_FILE: state,
      WAITER_COUNT_FILE: waiterCount,
      SERVICE_READ_COUNT_FILE: serviceReadCount,
      TASK_READ_COUNT_FILE: taskReadCount,
      REMOTE_READ_COUNT_FILE: remoteReadCount,
      OLD_ARN: oldArn,
      NEW_ARN: newArn,
      PASS_ROLE_DECISION: passRoleDecision,
      FAIL_SMOKE: String(failSmoke),
      FAIL_CONFIRMATION: String(failConfirmation),
      FAIL_UPDATE_AFTER_MUTATION: String(failUpdateAfterMutation),
      FAIL_ROLLBACK_UPDATE: String(failRollbackUpdate),
      FAIL_FORWARD_WAITER: String(failForwardWaiter),
      LONG_RUNNING_WAITER: String(longRunningWaiter),
      LONG_RUNNING_ROLLBACK_WAITER: String(longRunningRollbackWaiter),
      SMOKE_ATTEMPTS: smokeAttempts,
      SMOKE_DELAY_SECONDS: smokeDelaySeconds,
      HTTP_STATUS: httpStatus,
      HEALTH_BODY: healthBody,
      ALB_ARN: albArn,
      LISTENER_ARN: listenerArn,
      TARGET_GROUP_ALB_ARN: targetGroupAlbArn,
      EXPECTED_IMAGE: `999999999999.dkr.ecr.us-east-1.amazonaws.com/view-show-api@${expectedImageDigest}`,
      EXPECTED_CONTAINER: "view-show-api",
      EXPECTED_SHA: commitSha,
      LIVE_IMAGE_DIGEST: liveImageDigest,
      LIVE_IMAGE_MEDIA_TYPE: liveImageMediaType,
      RESOLVE_TARGET_GROUP: String(resolveTargetGroup),
      RESOLVE_ALB: String(resolveAlb),
      ACTUAL_ACCOUNT: actualAccount,
      CALLER_ARN: callerArn,
      REPOSITORY_HEAD: repositoryHead,
      INITIAL_REMOTE_HEAD: initialRemoteHead,
      LATE_REMOTE_HEAD: lateRemoteHead,
      AWS_ACCOUNT_ID: "999999999999",
      AWS_DEFAULT_REGION: "us-east-1",
      ECR_REPOSITORY: "view-show-api",
      ECS_CLUSTER: "view-show-cluster",
      ECS_SERVICE: "view-show-api-service",
      ECS_TASK_FAMILY: "view-show-api-task",
      ECS_CONTAINER_NAME: "view-show-api",
      ALB_NAME: "view-show-alb",
      CI_COMMIT_SHA: commitSha,
      BACKEND_IMAGE_DIGEST: expectedImageDigest,
      WAITER_TERM_GRACE_ATTEMPTS: "2",
      WAITER_TERM_GRACE_DELAY_SECONDS: "0.05",
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
  assert.doesNotMatch(
    result.stderr,
    /unexpected aws call:/,
    `strict fake AWS rejected an undeclared interaction:\n${result.stderr}`,
  );

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
  assert.match(
    passRoleCalls.join("\n"),
    /ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks\.amazonaws\.com,ContextKeyType=string/,
  );
  const operations = calls
    .trim()
    .split("\n")
    .map((line) => {
      if (line.startsWith("curl:")) return "curl";
      if (line.startsWith("git:")) return "git";
      if (line.includes("sts get-caller-identity")) return "identity";
      if (line.includes("ecs describe-services") && line.includes("--output json")) return "service";
      if (line.includes("ecr describe-images")) return "image";
      if (line.includes("ecs describe-task-definition")) return "task";
      if (line.includes("elbv2 describe-target-groups")) return "target-group";
      if (line.includes("elbv2 describe-load-balancers")) return "alb";
      if (line.includes("elbv2 describe-listeners")) return "listeners";
      if (line.includes("elbv2 describe-rules")) return "rules";
      if (line.includes("iam simulate-principal-policy")) return "pass-role";
      if (line.includes("ecs register-task-definition")) return "register";
      if (line.includes("ecs update-service")) return "update";
      if (line.includes("ecs wait services-stable")) return "wait";
      return "unexpected";
    });
  assert.deepEqual(operations, [
    "git",
    "git",
    "identity",
    "wait",
    "service",
    "image",
    "task",
    "target-group",
    "alb",
    "listeners",
    "rules",
    "pass-role",
    "pass-role",
    "service",
    "task",
    "git",
    "register",
    "update",
    "wait",
    "service",
    "curl",
  ]);
  assert.match(result.stdout, /deployment healthy/);
  assert.match(result.stdout, new RegExp(commitSha));
});

test("failed public smoke restores and confirms the previous task definition", () => {
  const { result, calls, state } = runDeploy({ failSmoke: true });
  assert.notEqual(result.status, 0);
  const updates = calls.split("\n").filter((line) => line.includes("ecs update-service"));
  const serviceReads = calls
    .split("\n")
    .filter((line) => line.includes("ecs describe-services") && line.includes("--output json"));
  assert.equal(updates.length, 2);
  assert.equal(serviceReads.length, 4);
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
    targetGroupAlbArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:loadbalancer/app/other/789",
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

test("forward waiter failure restores the previous task definition and preserves status", () => {
  const { result, calls, state } = runDeploy({ failForwardWaiter: true });
  assert.equal(result.status, 42);
  assert.equal(state, oldArn);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecs update-service")).length, 2);
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
  assert.ok(
    elapsedMilliseconds < maxSignalCleanupMilliseconds,
    `rollback took ${elapsedMilliseconds}ms`,
  );
});

test("termination during rollback waiter is bounded and preserves the original failure", () => {
  const startedAt = Date.now();
  const { result, calls } = runDeploy({ failSmoke: true, longRunningRollbackWaiter: true });
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rollback could not be confirmed/);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecs update-service")).length, 2);
  assert.ok(
    elapsedMilliseconds < maxSignalCleanupMilliseconds,
    `rollback waiter termination took ${elapsedMilliseconds}ms`,
  );
});

test("conflicting dotenv environment value cannot override the downloaded artifact", () => {
  const conflictingDigest = `sha256:${"c".repeat(64)}`;
  const { result, calls } = runDeploy({
    envOverrides: { BACKEND_IMAGE_DIGEST: conflictingDigest },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicts with backend-image.env/);
  assert.equal(calls, "");
});

for (const [name, artifactContent] of [
  ["wrong key", `OTHER_IMAGE_DIGEST=${imageDigest}\n`],
  ["extra line", `BACKEND_IMAGE_DIGEST=${imageDigest}\nUNTRUSTED=value\n`],
  ["invalid digest", "BACKEND_IMAGE_DIGEST=sha256:invalid\n"],
]) {
  test(`${name} in backend-image.env fails before external calls`, () => {
    const { result, calls } = runDeploy({ artifactContent });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backend-image.env must contain exactly one valid digest line/);
    assert.equal(calls, "");
  });
}

test("symlinked backend-image.env fails before external calls", () => {
  const { result, calls } = runDeploy({ artifactSymlink: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backend-image.env must be a regular non-symlink file/);
  assert.equal(calls, "");
});

test("invalid expected digest fails before any AWS call", () => {
  const { result, calls } = runDeploy({ expectedImageDigest: "sha256:not-a-digest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backend-image.env must contain exactly one valid digest line/);
  assert.equal(calls, "");
});

test("live ECR digest mismatch fails before registering or updating ECS", () => {
  const { result, calls } = runDeploy({ liveImageDigest: `sha256:${"c".repeat(64)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ECR digest does not match publication artifact/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("live ECR single-platform OCI image manifest is accepted", () => {
  const { result } = runDeploy({ liveImageMediaType: ociImageMediaType });
  assert.equal(result.status, 0, result.stderr);
});

test("live ECR multi-platform index fails before registering or updating ECS", () => {
  const { result, calls } = runDeploy({ liveImageMediaType: ociIndexMediaType });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /single-platform image manifest/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

for (const runtimePlatform of [
  { operatingSystemFamily: "LINUX", cpuArchitecture: "ARM64" },
  { operatingSystemFamily: "WINDOWS_SERVER_2022_CORE", cpuArchitecture: "X86_64" },
]) {
  test(`live task runtime ${runtimePlatform.operatingSystemFamily}/${runtimePlatform.cpuArchitecture} fails before mutation`, () => {
    const { result, calls } = runDeploy({ runtimePlatform });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime platform must be Linux\/X86_64/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

for (const [name, options] of [
  ["INACTIVE", { taskStatus: "INACTIVE" }],
  ["DELETE_IN_PROGRESS", { taskStatus: "DELETE_IN_PROGRESS" }],
  ["delete-requested", { taskDeleteRequestedAt: "2026-08-27T12:00:00Z" }],
]) {
  test(`${name} rollback task definition fails before mutation`, () => {
    const { result, calls } = runDeploy(options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rollback task definition must be ACTIVE and not deletion-requested/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

test("late deletion request for rollback task definition fails before mutation", () => {
  const { result, calls } = runDeploy({
    lateTaskOverrides: {
      status: "DELETE_IN_PROGRESS",
      deleteRequestedAt: "2026-08-27T12:00:00Z",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback task definition changed before deployment mutation/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("AWS endpoint overrides fail before any AWS call", () => {
  const { result, calls } = runDeploy({
    envOverrides: { AWS_ENDPOINT_URL_ECS: "https://example.invalid" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS endpoint overrides are not allowed/);
  assert.equal(calls, "");
});

test("caller must be the exact voclabs assumed role", () => {
  const { result, calls } = runDeploy({
    callerArn: "arn:aws:sts::999999999999:assumed-role/other-role/test-session",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected AWS caller/);
  assert.deepEqual(calls.trim().split("\n"), [
    "git:rev-parse --verify HEAD",
    "git:ls-remote --exit-code origin refs/heads/develop",
    "aws:sts get-caller-identity --output json",
  ]);
});

for (const [name, serviceOverrides] of [
  ["multiple deployments", {
    deployments: [
      { status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: oldArn },
      { status: "ACTIVE", rolloutState: "COMPLETED", taskDefinition: oldArn },
    ],
  }],
  ["incomplete primary deployment", {
    deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS", taskDefinition: oldArn }],
  }],
  ["pending tasks", { pendingCount: 1 }],
  ["running count mismatch", { runningCount: 0 }],
  ["operator minimum percent", {
    deploymentConfiguration: { minimumHealthyPercent: 50, maximumPercent: 200 },
  }],
  ["operator maximum percent", {
    deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 150 },
  }],
]) {
  test(`${name} is rejected as a rollback base before ECS mutation`, () => {
    const { result, calls } = runDeploy({ serviceOverrides });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /safe rollback base/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

for (const [name, albOverrides] of [
  ["non-active ALB", { State: { Code: "provisioning" } }],
  ["non-application ALB", { Type: "network" }],
  ["non-public ALB", { Scheme: "internal" }],
]) {
  test(`${name} fails before ECS mutation`, () => {
    const { result, calls } = runDeploy({ albOverrides });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ALB must be active, application, and internet-facing/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

test("ALB without an HTTP health route to the service target group fails before mutation", () => {
  const { result, calls } = runDeploy({ routeHealthToTargetGroup: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALB HTTP listener does not route \/health/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("ALB health rule with an additional host condition fails before mutation", () => {
  const { result, calls } = runDeploy({
    rulesOverride: [{
      RuleArn: `${listenerArn}/host-constrained`,
      Priority: "1",
      IsDefault: false,
      Conditions: [
        { Field: "path-pattern", Values: ["/health"] },
        { Field: "host-header", Values: ["api.example.test"] },
      ],
      Actions: [{
        Type: "forward",
        TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
      }],
    }],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALB HTTP listener does not route \/health/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("ALB health rule with zero target weight fails before mutation", () => {
  const { result, calls } = runDeploy({
    rulesOverride: [{
      RuleArn: `${listenerArn}/zero-weight`,
      Priority: "1",
      IsDefault: false,
      Conditions: [{ Field: "path-pattern", Values: ["/health"] }],
      Actions: [{
        Type: "forward",
        ForwardConfig: {
          TargetGroups: [{
            TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
            Weight: 0,
          }],
        },
      }],
    }],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALB HTTP listener does not route \/health/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("only the exact HTTP port 80 listener can authorize public smoke", () => {
  const { result, calls } = runDeploy({ listenerPort: 8080 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALB HTTP port 80 listener does not route \/health/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("higher-priority health route to another target shadows a good default", () => {
  const otherTarget = "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/other/999";
  const serviceTarget = "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123";
  const { result, calls } = runDeploy({
    rulesOverride: [{
      RuleArn: `${listenerArn}/shadow`,
      Priority: "1",
      IsDefault: false,
      Conditions: [{ Field: "path-pattern", Values: ["/health"] }],
      Actions: [{ Type: "forward", TargetGroupArn: otherTarget }],
    }, {
      RuleArn: `${listenerArn}/default`,
      Priority: "default",
      IsDefault: true,
      Conditions: [],
      Actions: [{ Type: "forward", TargetGroupArn: serviceTarget }],
    }],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /effective ALB HTTP port 80 route/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("higher-priority regex health route cannot be skipped in favor of a good default", () => {
  const otherTarget = "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/other/999";
  const serviceTarget = "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123";
  const { result, calls } = runDeploy({
    rulesOverride: [{
      RuleArn: `${listenerArn}/regex-shadow`,
      Priority: "1",
      IsDefault: false,
      Conditions: [{ Field: "path-pattern", RegexValues: ["^/health$"] }],
      Actions: [{ Type: "forward", TargetGroupArn: otherTarget }],
    }, {
      RuleArn: `${listenerArn}/default`,
      Priority: "default",
      IsDefault: true,
      Conditions: [],
      Actions: [{ Type: "forward", TargetGroupArn: serviceTarget }],
    }],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regex-based ALB rule condition is not allowed/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("weighted multi-target health forwarding fails before mutation", () => {
  const { result, calls } = runDeploy({
    rulesOverride: [{
      RuleArn: `${listenerArn}/weighted`,
      Priority: "1",
      IsDefault: false,
      Conditions: [{ Field: "path-pattern", Values: ["/health"] }],
      Actions: [{
        Type: "forward",
        ForwardConfig: {
          TargetGroups: [{
            TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
            Weight: 50,
          }, {
            TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/other/999",
            Weight: 50,
          }],
        },
      }],
    }],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /effective ALB HTTP port 80 route/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

for (const pathPattern of ["/health?", "/*/health"]) {
  test(`ambiguous ALB path pattern ${pathPattern} cannot authorize the health route`, () => {
    const serviceTarget = "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123";
    const { result, calls } = runDeploy({
      rulesOverride: [{
        RuleArn: `${listenerArn}/ambiguous`,
        Priority: "1",
        IsDefault: false,
        Conditions: [{ Field: "path-pattern", Values: [pathPattern] }],
        Actions: [{ Type: "forward", TargetGroupArn: serviceTarget }],
      }, {
        RuleArn: `${listenerArn}/default`,
        Priority: "default",
        IsDefault: true,
        Conditions: [],
        Actions: [{ Type: "forward", TargetGroupArn: serviceTarget }],
      }],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /effective ALB HTTP port 80 route/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

test("repository HEAD mismatch fails before any AWS call", () => {
  const { result, calls } = runDeploy({ repositoryHead: "f".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI_COMMIT_SHA does not match checked-out HEAD/);
  assert.deepEqual(calls.trim().split("\n"), ["git:rev-parse --verify HEAD"]);
});

test("stale develop commit fails before any AWS call", () => {
  const { result, calls } = runDeploy({ initialRemoteHead: "f".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /develop head does not match CI_COMMIT_SHA/);
  assert.doesNotMatch(calls, /aws:/);
  assert.match(calls, /git:ls-remote --exit-code origin refs\/heads\/develop/);
});

test("develop head network or auth failure is generic and fails before AWS", () => {
  const { result, calls } = runDeploy({ initialRemoteHead: "__FAIL__" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not verify current develop head/);
  assert.doesNotMatch(result.stderr, /secret-bearing origin/);
  assert.doesNotMatch(calls, /aws:/);
});

test("develop advancing during preflight aborts immediately before mutation", () => {
  const { result, calls } = runDeploy({ lateRemoteHead: "f".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /develop head does not match CI_COMMIT_SHA/);
  assert.equal(calls.split("\n").filter((line) => line.includes("git:ls-remote")).length, 2);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("external deployment changing the rollback baseline aborts before registration", () => {
  const externalArn = "arn:aws:ecs:us-east-1:999999999999:task-definition/view-show-api-task:99";
  const { result, calls } = runDeploy({
    lateServiceOverrides: {
      taskDefinition: externalArn,
      deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: externalArn }],
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback baseline changed before deployment mutation/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("external deployment configuration change aborts before registration", () => {
  const { result, calls } = runDeploy({
    lateServiceOverrides: {
      deploymentConfiguration: { minimumHealthyPercent: 50, maximumPercent: 200 },
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback baseline changed before deployment mutation/);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

test("forward waiter success still requires one strict completed stable deployment", () => {
  const { result, calls, state } = runDeploy({
    forwardStableOverrides: {
      deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS", taskDefinition: newArn }],
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(state, oldArn);
  assert.match(result.stderr, /ECS service is not strictly stable after forward waiter/);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecs update-service")).length, 2);
});

test("rollback stable-predicate failure preserves the original waiter status", () => {
  const { result, calls, state } = runDeploy({
    failForwardWaiter: true,
    rollbackStableOverrides: { pendingCount: 1 },
  });
  assert.equal(result.status, 42);
  assert.equal(state, oldArn);
  assert.match(result.stderr, /rollback could not be confirmed/);
  assert.equal(calls.split("\n").filter((line) => line.includes("ecs update-service")).length, 2);
});

for (const [name, loadBalancer] of [
  ["target group", {
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/other/999",
    containerName: "view-show-api",
    containerPort: 3000,
  }],
  ["container name", {
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
    containerName: "other-container",
    containerPort: 3000,
  }],
  ["container port", {
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/api/123",
    containerName: "view-show-api",
    containerPort: 3001,
  }],
]) {
  test(`late service ${name} drift aborts before registration`, () => {
    const { result, calls } = runDeploy({
      lateServiceOverrides: { loadBalancers: [loadBalancer] },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rollback baseline changed before deployment mutation/);
    assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
  });
}

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
  assert.deepEqual(calls.trim().split("\n"), [
    "git:rev-parse --verify HEAD",
    "git:ls-remote --exit-code origin refs/heads/develop",
    "aws:sts get-caller-identity --output json",
  ]);
  assert.doesNotMatch(calls, /ecs register-task-definition|ecs update-service/);
});

for (const [variable, value] of Object.entries({
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

for (const command of ["aws", "jq", "curl", "git", "mktemp", "rm", "sleep", "dirname", "mv"]) {
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
  ["missing image", { liveImageDigest: "None" }],
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

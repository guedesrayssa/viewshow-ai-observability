import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Integration-style tests for the repository-level Learner Lab command.
import { isExactConfirmation, runLearnerLab, validateOllamaBaseUrl } from "../aws-learner-lab-ecs-legacy.mjs";

test("legacy ECS CLI permits only historical help before any subprocess", async (t) => {
  const script = fileURLToPath(new URL("../aws-learner-lab-ecs-legacy.mjs", import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), "ecs-legacy-cli-"));
  const calls = path.join(directory, "calls");
  try {
    for (const program of ["terraform", "aws", "node", "npm", "python3.12", "python3", "python", "kubectl", "helm"]) {
      writeFileSync(path.join(directory, program), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$LEGACY_CALL_LOG"\nexit 1\n', { mode: 0o755 });
    }
    for (const command of [undefined, "help", "--help", "-h", "setup", "deploy", "destroy", "check", "evidence"]) {
      await t.test(command ?? "default help", () => {
        const result = spawnSync(process.execPath, [script, ...(command === undefined ? [] : [command])], {
          encoding: "utf8",
          env: { ...process.env, PATH: directory, LEGACY_CALL_LOG: calls },
        });
        if (command === undefined || ["help", "--help", "-h"].includes(command)) {
          assert.equal(result.status, 0, command);
          assert.match(result.stdout, /LEGADO ECS/);
        } else {
          assert.equal(result.status, 2, command);
          assert.match(result.stderr, /Terraform ECS não está mais disponível/);
        }
        assert.equal(readdirSync(directory).includes("calls"), false, command);
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ORIGINAL_ROOT = ROOT;
test("imported historical setup resolves default terminal helpers without a TTY", () => {
  const moduleUrl = new URL("../aws-learner-lab-ecs-legacy.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { runLearnerLab } from ${JSON.stringify(moduleUrl)};
    const result = await runLearnerLab({
      step: "setup",
      log: (message) => process.stderr.write(String(message) + "\\n"),
    });
    process.exitCode = result.status;
  `], {
    encoding: "utf8",
    input: "admin@example.com\n",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /a TTY is required to read the import-canary password/);
  assert.match(result.stdout, /Initial user email:/);
  assert.doesNotMatch(result.stderr, /is not defined|ReferenceError/);
});

const SAFE_PLAN_VARIABLES = {
  deployment_namespace: "view-show",
  regiao: "us-east-1",
  ambiente: "learner-lab",
  bedrock_habilitado: false,
  observabilidade_habilitada: false,
  grafana_cidr_acesso: null,
  bastion_admin_cidr: null,
  bastion_key_name: "vockey",
  tipo_instancia_bastion: "t3.micro",
  cpu_task: "256",
  memoria_task: "512",
  quantidade_tasks: 1,
  ecs_capacidade_minima: 1,
  ecs_capacidade_maxima: 4,
  ingestion_backfill_cpu: "2048",
  ingestion_backfill_memoria: "8192",
  ingestion_backfill_ephemeral_storage_gib: 200,
  ingestion_sync_cpu: "1024",
  ingestion_sync_memoria: "2048",
  scheduler_ingestao_habilitado: false,
  force_destroy_bucket_ingestao: true,
  force_delete_ecr_ingestao: true,
  import_canonical_first_production_approved: false,
  acoes_alarme_ingestao: [],
};

function testEnvironment({
  root = ROOT,
  platform = "linux",
  missing = [],
  credentialsActive = true,
  pythonVersion = "Python 3.12.11",
  venvVersion = "Python 3.12.11",
  identityArn = "arn:aws:sts::111122223333:assumed-role/voclabs/aluno@example.edu",
  taskExitCode = 0,
  runStage = "SUCCEEDED",
  terraformVersion = "1.14.3",
  nodeVersion = "v22.22.0",
  awsCliVersion = "aws-cli/2.31.0 Python/3.13.7 Linux/6.8.0 exe/x86_64",
  awsCliVersionStream = "stderr",
  npmVersion = "10.9.4",
  terraformWorkspace = "default",
  keyPairExists = true,
  keyPairPayload = { KeyPairs: [{ KeyName: "vockey" }] },
  environment = { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
  gateAccepted = true,
  localTerraformFiles = [],
  venvExists = true,
  ingestionPackageInstalled = true,
  ingestionPackageInstallStatus = 0,
  pythonCommandVersions = {},
  planVariableOverrides = {},
  analysisDesiredCount = 0,
  analysisOperationOverrides = {},
  analysisServiceOverrides = {},
  analysisTaskExitCode = 0,
  analysisTaskStopCode = "EssentialContainerExited",
  analysisTaskFailures = [],
  analysisCanaryState = "SUCCEEDED",
  analysisCanaryInitialEmptyReads = 0,
  observabilityEndpoint = "http://10.0.10.5:4320",
  grafanaAccess = {
    usuario: "admin",
    tunel_ssm: "aws ssm start-session --target i-0123456789abcdef0",
    url_tunel: "http://localhost:3002",
  },
  observabilityInstanceId = "i-0123456789abcdef0",
  grafanaPassword = "TestGrafanaPassword123",
  grafanaHealthStatus = "Success",
  analysisManifest = null,
  isTty = true,
  bastionAccess = { instancia_id: "i-0abc1234def567890" },
  bastionPrivateIp = "10.0.10.20",
  updateGateAccepted = true,
  activeImportId = null,
  activeImportIds = null,
  emptyActiveImportOutput = false,
  stateLineage = "lineage-1",
  localStateSerial = 7,
  remoteStateSerial = 7,
  postApplyStateSerial = 8,
  stateStat = null,
  stateFileText = null,
  runbookOwner = "111122223333",
  runbookImage = INGESTION_IMAGE,
  postApplyTerraformState = { values: { root_module: { resources: [] } } },
  updatePlanTerraformState = postApplyTerraformState,
  planIngestionImage = INGESTION_IMAGE,
  planIngestionHash = INGESTION_SOURCE_HASH,
  planEcrUnknownMarker = true,
  planEcrOmitsDigest = false,
  planOutputUnknownMarker = true,
  planOutputUnknownMarkerPresent = true,
  planOutputUsesNull = false,
  planContainerUnknownMarker = true,
  planFileBytes = Buffer.from("validated terraform plan bytes"),
  replacementPlanBytes = null,
  closePlanError = null,
  removeArtifactFileError = null,
  artifactParentStat = null,
  cognitoUserExists = false,
  snapshotSecretHasCurrentVersion = false,
  putSnapshotSecretFails = false,
  gitCheckout = root === ROOT ? "main" : "linked",
} = {}) {
  const calls = [];
  const directories = [];
  const permissions = [];
  const renames = [];
  const copies = [];
  const temporaryDirectories = [];
  const planDescriptors = [];
  const closedPlanDescriptors = [];
  const artifactEntries = new Map();
  const removedArtifactFiles = [];
  const removedArtifactDirectories = [];
  const artifactLifecycle = [];
  const descriptorTargets = new Map();
  const backupDescriptors = [];
  const closedBackupDescriptors = [];
  const backupDescriptorTargets = new Map();
  const backupOpens = [];
  const backupWrites = [];
  const defaultStateStat = {
    uid: 1000,
    dev: 1,
    ino: 2,
    nlink: 1,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const gitMetadataStat = {
    uid: 1000,
    dev: 1,
    ino: 3,
    nlink: 1,
    isFile: () => gitCheckout === "linked",
    isDirectory: () => gitCheckout === "main",
    isSymbolicLink: () => false,
  };
  let applied = false;
  let analysisCanaryReads = 0;
  let planReadCount = 0;
  let activeImportReadCount = 0;
  let cognitoUserCreated = cognitoUserExists;
  let snapshotSecretVersionCreated = snapshotSecretHasCurrentVersion;
  let analysisTaskStarted = false;
  let packageInstalled = ingestionPackageInstalled;
  const execute = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (missing.includes(command)) return { status: 127, stdout: "", stderr: "not found" };
    if (command === "terraform" && args.includes("version")) {
      return {
        status: 0,
        stdout: JSON.stringify({ terraform_version: terraformVersion }),
        stderr: "",
      };
    }
    if (command === "terraform" && args.includes("workspace") && args.includes("show")) {
      return { status: 0, stdout: `${terraformWorkspace}\n`, stderr: "" };
    }
    if (command === "node" && args[0] === "--version") {
      return { status: 0, stdout: `${nodeVersion}\n`, stderr: "" };
    }
    if (command === "npm" && args[0] === "--version") {
      return { status: 0, stdout: `${npmVersion}\n`, stderr: "" };
    }
    if (command === "cmd.exe" && args.at(-1) === "npm --version") {
      return { status: 0, stdout: `${npmVersion}\n`, stderr: "" };
    }
    if (
      command === "node" &&
      args.some((item) => String(item).includes("validate-create-plan"))
    ) {
      return gateAccepted
        ? { status: 0, stdout: "plan accepted\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "update action rejected" };
    }
    if (
      command === "node" &&
      args.some((item) => String(item).includes("validate-learner-update-plan"))
    ) {
      return updateGateAccepted
        ? { status: 0, stdout: "update plan accepted\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "unexpected address" };
    }
    if (command === "aws" && args[0] === "--version") {
      return {
        status: 0,
        stdout: awsCliVersionStream === "stdout" ? `${awsCliVersion}\n` : "",
        stderr: awsCliVersionStream === "stderr" ? `${awsCliVersion}\n` : "",
      };
    }
    if (["python3.12", "python3", "python", "py"].includes(command) && args.at(-1) === "--version") {
      const invocation = [command, ...args.slice(0, -1)].join(" ");
      const version = pythonCommandVersions[invocation] ?? pythonVersion;
      return { status: 0, stdout: `${version}\n`, stderr: "" };
    }
    if (command.includes(".venv") && args[0] === "--version" && venvVersion !== null) {
      return { status: 0, stdout: `${venvVersion}\n`, stderr: "" };
    }
    if (command.includes(".venv") && args[0] === "-I" && args.includes("-c")) {
      return packageInstalled
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'domain'" };
    }
    if (command.includes(".venv") && args.includes("--editable")) {
      if (ingestionPackageInstallStatus === 0) packageInstalled = true;
      return {
        status: ingestionPackageInstallStatus,
        stdout: "",
        stderr: ingestionPackageInstallStatus === 0 ? "" : "pip: no network",
      };
    }
    if (command === "aws" && args[0] === "ec2" && args[1] === "describe-key-pairs") {
      return keyPairExists
        ? {
            status: 0,
            stdout: JSON.stringify(keyPairPayload),
            stderr: "",
          }
        : { status: 255, stdout: "", stderr: "InvalidKeyPair.NotFound" };
    }
    if (command === "aws" && args[0] === "ec2" && args[1] === "describe-instances") {
      return { status: 0, stdout: `${bastionPrivateIp}\n`, stderr: "" };
    }
    if (command === "aws" && args[0] === "ec2") {
      return credentialsActive
        ? { status: 0, stdout: "vpc-1\n", stderr: "" }
        : { status: 254, stdout: "", stderr: "voc-cancel-cred" };
    }
    if (command === "aws" && args[0] === "sts") {
      return {
        status: 0,
        stdout: JSON.stringify({ Account: "111122223333", Arn: identityArn, UserId: "test" }),
        stderr: "",
      };
    }
    if (
      command === "aws" &&
      args[0] === "secretsmanager" &&
      args[1] === "list-secret-version-ids"
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          Versions: snapshotSecretVersionCreated
            ? [{ VersionId: "current-version", VersionStages: ["AWSCURRENT"] }]
            : [],
        }),
        stderr: "",
      };
    }
    if (
      command === "aws" &&
      args[0] === "secretsmanager" &&
      args[1] === "put-secret-value"
    ) {
      if (putSnapshotSecretFails) {
        return { status: 1, stdout: "", stderr: "AccessDeniedException" };
      }
      snapshotSecretVersionCreated = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "aws" && args[0] === "cognito-idp" && args[1] === "admin-get-user") {
      return cognitoUserCreated
        ? {
            status: 0,
            stdout: JSON.stringify({ Username: "admin@example.com", UserStatus: "CONFIRMED" }),
            stderr: "",
          }
        : { status: 254, stdout: "", stderr: "UserNotFoundException" };
    }
    if (command === "aws" && args[0] === "cognito-idp" && args[1] === "admin-create-user") {
      cognitoUserCreated = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (
      command === "aws" &&
      args[0] === "cognito-idp" &&
      args[1] === "admin-set-user-password"
    ) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "wait") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "run-task") {
      analysisTaskStarted = true;
      return {
        status: 0,
        stdout: JSON.stringify({
          failures: analysisTaskFailures,
          tasks: analysisTaskFailures.length === 0
            ? [{ taskArn: "arn:aws:ecs:us-east-1:111122223333:task/view-show/analysis-task-1" }]
            : [],
        }),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-services") {
      return {
        status: 0,
        stdout: JSON.stringify({
          failures: [],
          services: [{
            serviceName: "view-show-analysis-worker",
            clusterArn: "arn:aws:ecs:us-east-1:111122223333:cluster/view-show-iac-cluster",
            taskDefinition: "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-analysis-worker:1",
            desiredCount: analysisDesiredCount,
            launchType: "FARGATE",
            status: "ACTIVE",
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: ["subnet-aaa111", "subnet-bbb222"],
                securityGroups: ["sg-abc123"],
                assignPublicIp: "DISABLED",
              },
            },
            ...analysisServiceOverrides,
          }],
        }),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-task-definition") {
      return {
        status: 0,
        stdout: JSON.stringify({
          taskDefinition: {
            containerDefinitions: [{
              name: "analysis-worker",
              environment: [{ name: "OLLAMA_BASE_URL", value: OLLAMA_URL }],
            }],
          },
        }),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-tasks") {
      if (analysisTaskStarted) {
        return {
          status: 0,
          stdout: JSON.stringify({
            failures: [],
            tasks: [{
              taskArn: "arn:aws:ecs:us-east-1:111122223333:task/view-show/analysis-task-1",
              lastStatus: "STOPPED",
              stopCode: analysisTaskStopCode,
              containers: [{ name: "analysis-worker", lastStatus: "STOPPED", exitCode: analysisTaskExitCode }],
            }],
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          failures: [],
          tasks: [
            {
              taskArn: "arn:aws:ecs:us-east-1:111122223333:task/view-show/task-1",
              lastStatus: "STOPPED",
              containers: [
                { name: "ingestion", lastStatus: "STOPPED", exitCode: taskExitCode },
                { name: "mysql-snapshot", lastStatus: "STOPPED", exitCode: taskExitCode },
              ],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (
      command === "aws" &&
      args[0] === "dynamodb" &&
      args[1] === "get-item" &&
      args.join(" ").includes("CONTROL#IMPORT")
    ) {
      const currentActiveImportId = Array.isArray(activeImportIds)
        ? activeImportIds[Math.min(activeImportReadCount, activeImportIds.length - 1)]
        : activeImportId;
      activeImportReadCount += 1;
      return {
        status: 0,
        stdout: emptyActiveImportOutput
          ? ""
          : JSON.stringify(
              currentActiveImportId === null
                ? {}
                : {
                    Item: {
                      pk: { S: "CONTROL#IMPORT" },
                      sk: { S: "ACTIVE" },
                      importId: { S: currentActiveImportId },
                      privateSnapshotKey: { S: "must-not-be-printed" },
                    },
                  },
            ),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "dynamodb" && args[1] === "get-item") {
      if (args.join(" ").includes("ANALYSIS#RUN#")) {
        analysisCanaryReads += 1;
        return {
          status: 0,
          stdout: analysisCanaryReads <= analysisCanaryInitialEmptyReads
            ? ""
            : JSON.stringify({ Item: { state: { S: analysisCanaryState } } }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          Item: {
            pk: { S: "INGESTION#RUN#smoke-run-1" },
            sk: { S: "META" },
            runId: { S: "smoke-run-1" },
            stage: { S: runStage },
          },
        }),
        stderr: "",
      };
    }
    if (command === "docker" && args[0] === "info") {
      return { status: 0, stdout: "Server Version: 29\n", stderr: "" };
    }
    if (command === "aws" && args[0] === "sqs" && args[1] === "send-message") {
      return { status: 0, stdout: JSON.stringify({ MessageId: "message-canary-1" }), stderr: "" };
    }
    if (command === "aws" && args[0] === "ssm" && args[1] === "send-command") {
      return {
        status: 0,
        stdout: JSON.stringify({ Command: { CommandId: "command-grafana-health" } }),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ssm" && args[1] === "wait") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "aws" && args[0] === "ssm" && args[1] === "get-command-invocation") {
      return {
        status: 0,
        stdout: JSON.stringify({
          Status: grafanaHealthStatus,
          StandardOutputContent: grafanaHealthStatus === "Success"
            ? "GRAFANA_READY CLOUDWATCH_READY DASHBOARDS=view-show-ingestion,view-show-agentic-aws\n"
            : "",
          StandardErrorContent: grafanaHealthStatus === "Success" ? "" : "health check failed",
        }),
        stderr: "",
      };
    }
    if (command === "terraform" && args.includes("output")) {
      if (args.at(-1) === "grafana_acesso") {
        return { status: 0, stdout: JSON.stringify(grafanaAccess), stderr: "" };
      }
      if (args.at(-1) === "observabilidade_instancia_id") {
        return { status: 0, stdout: `${observabilityInstanceId}\n`, stderr: "" };
      }
      if (args.at(-1) === "grafana_senha") {
        return { status: 0, stdout: `${grafanaPassword}\n`, stderr: "" };
      }
      if (args.at(-1) === "bastion_acesso") {
        return { status: 0, stdout: JSON.stringify(bastionAccess), stderr: "" };
      }
      if (args.at(-1) === "observabilidade_otlp_workers_endpoint") {
        if (observabilityEndpoint === null && !applied) {
          return {
            status: 1,
            stdout: "",
            stderr: 'Error: Output "observabilidade_otlp_workers_endpoint" not found',
          };
        }
        const endpoint = observabilityEndpoint === null && applied
          ? "http://10.0.10.5:4320"
          : observabilityEndpoint;
        return { status: 0, stdout: JSON.stringify(endpoint), stderr: "" };
      }
      if (args.at(-1) === "analysis_worker_operacao") {
        return {
          status: 0,
          stdout: JSON.stringify({
            cluster_name: "view-show-iac-cluster",
            task_definition: "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-analysis-worker:1",
            task_family: "view-show-analysis-worker",
            container_name: "analysis-worker",
            subnet_ids: ["subnet-aaa111", "subnet-bbb222"],
            security_group_id: "sg-abc123",
            assign_public_ip: false,
            log_group: "/ecs/view-show-analysis-worker",
            analysis_queue_url: "https://sqs.us-east-1.amazonaws.com/111122223333/view-show-ingestion-analysis",
            operational_table: "view-show-iac-operacional",
            desired_count: analysisDesiredCount,
            ...analysisOperationOverrides,
          }),
          stderr: "",
        };
      }
      if (args.includes("-raw")) {
        const values = {
          painel_url: "https://example.test",
          api_url_https: "https://api.example.test",
          cognito_user_pool_id: "us-east-1_example",
          cognito_client_id: "client-example",
        };
        const name = args.at(-1);
        return Object.hasOwn(values, name)
          ? { status: 0, stdout: `${values[name]}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: `unknown output ${String(name)}` };
      }
      if (!args.includes("ingestion_runbook")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            painel_url: { sensitive: false, type: "string", value: "https://example.test" },
            api_url_https: {
              sensitive: false,
              type: "string",
              value: "https://api.example.test",
            },
            cognito_user_pool_id: {
              sensitive: false,
              type: "string",
              value: "us-east-1_example",
            },
            cognito_client_id: {
              sensitive: false,
              type: "string",
              value: "client-example",
            },
            ingestion_runbook: {
              sensitive: false,
              type: "object",
              value: {
                storage: { bucket: "view-show-ingestion-111122223333-us-east-1" },
                runtime: {
                  cluster_arn:
                    "arn:aws:ecs:us-east-1:111122223333:cluster/view-show-cluster",
                },
                data: {
                  operational_table: "view-show-operacional",
                  snapshot_secret_arn:
                    "arn:aws:secretsmanager:us-east-1:111122223333:secret:view-show-ingestion/snapshot-mysql",
                },
              },
            },
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          storage: { bucket: "view-show-ingestion-111122223333-us-east-1" },
          image: { immutable_uri: runbookImage },
          imports: {
            expected_bucket_owner: runbookOwner,
            task_definition_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-import:8",
          },
          runtime: {
            cluster_arn: "arn:aws:ecs:us-east-1:111122223333:cluster/view-show-cluster",
            backfill_task_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-backfill:8",
            import_task_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-import:8",
            sync_task_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-sync:8",
          },
          data: {
            operational_table: "view-show-operacional",
            snapshot_secret_arn:
              "arn:aws:secretsmanager:us-east-1:111122223333:secret:view-show-ingestion/snapshot-mysql",
          },
          scheduler: {
            name: "view-show-ingestion-sync",
            schedule_arn:
              "arn:aws:scheduler:us-east-1:111122223333:schedule/view-show-ingestion/view-show-ingestion-sync",
          },
          incremental: {
            export_task_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-incremental-export:8",
            ingest_task_arn:
              "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-incremental-ingest:8",
            export_schedule_arn:
              "arn:aws:scheduler:us-east-1:111122223333:schedule/view-show-ingestion/view-show-ingestion-incremental-export",
            ingest_schedule_arn:
              "arn:aws:scheduler:us-east-1:111122223333:schedule/view-show-ingestion/view-show-ingestion-incremental-ingest",
          },
        }),
        stderr: "",
      };
    }
    if (command === "terraform" && args.includes("state") && args.includes("pull")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          lineage: stateLineage,
          serial: applied ? postApplyStateSerial : remoteStateSerial,
        }),
        stderr: "",
      };
    }
    if (command === "terraform" && args.includes("show") && args.includes("-json")) {
      const isSavedPlan = args.some(
        (item) =>
          String(item).endsWith(".tfplan") ||
          String(item).startsWith("/proc/self/fd/") ||
          String(item).startsWith("/dev/fd/"),
      );
      if (!isSavedPlan) {
        return {
          status: 0,
          stdout: JSON.stringify(postApplyTerraformState),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify(
          updatePlanJsonFromState(
            updatePlanTerraformState,
            {
              ...SAFE_PLAN_VARIABLES,
              ...planVariableOverrides,
            },
            {
              ingestionImage: planIngestionImage,
              ingestionHash: planIngestionHash,
              ecrUnknownMarker: planEcrUnknownMarker,
              ecrOmitsDigest: planEcrOmitsDigest,
              outputUnknownMarker: planOutputUnknownMarker,
              outputUnknownMarkerPresent: planOutputUnknownMarkerPresent,
              outputUsesNull: planOutputUsesNull,
              containerUnknownMarker: planContainerUnknownMarker,
            },
          ),
        ),
        stderr: "",
      };
    }
    if (command === "terraform" && args.includes("plan")) {
      const output = args.find((item) => String(item).startsWith("-out="))?.slice(5);
      if (output) {
        artifactEntries.set(output, {
          uid: 1000,
          dev: 1,
          ino: 2,
          nlink: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        });
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "terraform" && args.includes("apply")) applied = true;
    if (args.some((item) => String(item).includes("run_task.py"))) {
      return {
        status: 0,
        stdout: JSON.stringify({
          taskArn: "arn:aws:ecs:us-east-1:111122223333:task/view-show/task-1",
          runId: "smoke-run-1",
          activated: false,
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const logs = [];
  return {
    calls,
    logs,
    options: {
      step: "all",
      root,
      platform,
      execute,
      log: (line) => logs.push(String(line)),
      exists: (target) => (String(target).includes(".venv") ? venvExists : true),
      readDirectory: () => localTerraformFiles,
      makeDirectory: (directory, options) => {
        directories.push({ directory, options });
        if (String(directory).endsWith(`${path.sep}.terraform-artifacts`)) {
          artifactEntries.set(
            directory,
            artifactParentStat ?? {
              uid: 1000,
              dev: 1,
              ino: 50,
              nlink: 1,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          );
        } else if (String(directory).endsWith(`${path.sep}state-backups`)) {
          artifactEntries.set(directory, {
            uid: 1000,
            dev: 1,
            ino: 75,
            nlink: 1,
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          });
        }
      },
      writeFile: () => {},
      renameFile: (source, target) => renames.push({ source, target }),
      changeMode: (target, mode) => permissions.push({ target, mode }),
      confirm: async () => true,
      environment,
      lstat: (target) =>
        String(target) === path.join(root, ".git")
          ? gitMetadataStat
          : (stateStat ?? defaultStateStat),
      readFile: (target) => String(target).endsWith("analysis-worker.json") && analysisManifest !== null
        ? JSON.stringify(analysisManifest)
        : stateFileText ??
          JSON.stringify({
            lineage: stateLineage,
            serial: applied ? postApplyStateSerial : localStateSerial,
          }),
      readPlanFile: () => {
        planReadCount += 1;
        return planReadCount > 1 && replacementPlanBytes !== null
          ? replacementPlanBytes
          : planFileBytes;
      },
      makeTemporaryDirectory: (prefix) => {
        const directory = `${prefix}run-${temporaryDirectories.length + 1}`;
        temporaryDirectories.push(directory);
        artifactEntries.set(directory, {
          uid: 1000,
          dev: 1,
          ino: 100 + temporaryDirectories.length,
          nlink: 1,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        });
        return directory;
      },
      inspectArtifactPath: (target) => {
        const metadata = artifactEntries.get(target);
        if (!metadata) {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        }
        return metadata;
      },
      openPlanFile: (target) => {
        const descriptor = 40 + planDescriptors.length;
        planDescriptors.push(descriptor);
        descriptorTargets.set(descriptor, target);
        return descriptor;
      },
      inspectPlanFile: (descriptor) => artifactEntries.get(descriptorTargets.get(descriptor)),
      closePlanFile: (descriptor) => {
        if (closePlanError) throw closePlanError;
        closedPlanDescriptors.push(descriptor);
        artifactLifecycle.push(`close:${descriptor}`);
      },
      removeArtifactFile: (target) => {
        if (removeArtifactFileError) throw removeArtifactFileError;
        assert.equal(artifactEntries.get(target)?.isFile(), true);
        removedArtifactFiles.push(target);
        artifactLifecycle.push(`unlink:${target}`);
        artifactEntries.delete(target);
      },
      removeArtifactDirectory: (target) => {
        assert.equal(artifactEntries.get(target)?.isDirectory(), true);
        assert.equal(
          [...artifactEntries.keys()].some((entry) => path.dirname(entry) === target),
          false,
        );
        removedArtifactDirectories.push(target);
        artifactLifecycle.push(`rmdir:${target}`);
        artifactEntries.delete(target);
      },
      copyFile: (source, destination, mode) => {
        copies.push({ source, destination, mode });
        artifactEntries.set(destination, {
          uid: 1000,
          dev: 1,
          ino: 200 + copies.length,
          nlink: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        });
      },
      openBackupPath: (target, flags, mode) => {
        const descriptor = 80 + backupDescriptors.length;
        let logicalTarget = target;
        const anchored = String(target).match(/^\/(?:proc\/self|dev)\/fd\/(\d+)\/(.+)$/);
        if (anchored) {
          const directory = backupDescriptorTargets.get(Number(anchored[1]));
          if (directory === undefined) throw new Error("EBADF");
          logicalTarget = path.join(directory, anchored[2]);
          if (artifactEntries.has(logicalTarget)) throw new Error("EEXIST");
          artifactEntries.set(logicalTarget, {
            uid: 1000,
            dev: 1,
            ino: 300 + backupDescriptors.length,
            nlink: 1,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          });
        } else if ((flags & fsConstants.O_CREAT) !== 0) {
          if (artifactEntries.has(logicalTarget)) throw new Error("EEXIST");
          artifactEntries.set(logicalTarget, {
            uid: 1000,
            dev: 1,
            ino: 300 + backupDescriptors.length,
            nlink: 1,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          });
        }
        backupDescriptors.push(descriptor);
        backupDescriptorTargets.set(descriptor, logicalTarget);
        backupOpens.push({ target, logicalTarget, flags, mode, descriptor });
        return descriptor;
      },
      inspectBackupFile: (descriptor) => {
        const target = backupDescriptorTargets.get(descriptor);
        if (target === path.join(root, "apps", "fullstack", "terraform.tfstate")) {
          return stateStat ?? defaultStateStat;
        }
        return artifactEntries.get(target);
      },
      readBackupFile: () =>
        Buffer.from(
          stateFileText ??
            JSON.stringify({
              lineage: stateLineage,
              serial: applied ? postApplyStateSerial : localStateSerial,
            }),
        ),
      writeBackupFile: (descriptor, contents) => {
        backupWrites.push({
          descriptor,
          target: backupDescriptorTargets.get(descriptor),
          contents: Buffer.from(contents),
        });
      },
      closeBackupFile: (descriptor) => closedBackupDescriptors.push(descriptor),
      resolveArtifactPath: (target) => target,
      currentUserId: () => 1000,
      now: () => new Date("2026-09-21T12:34:56.789Z"),
      isTty: () => isTty,
    },
    directories,
    permissions,
    renames,
    copies,
    temporaryDirectories,
    planDescriptors,
    closedPlanDescriptors,
    artifactEntries,
    removedArtifactFiles,
    removedArtifactDirectories,
    artifactLifecycle,
    backupDescriptors,
    closedBackupDescriptors,
    backupDescriptorTargets,
    backupOpens,
    backupWrites,
  };
}

const UPDATE_PRESETS = Object.freeze({
  baseline: {
    ingestion_snapshot_page_size: 500,
    ingestion_snapshot_prepare_enabled: false,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase1-2000": {
    ingestion_snapshot_page_size: 2000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase1-5000": {
    ingestion_snapshot_page_size: 5000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase1-10000": {
    ingestion_snapshot_page_size: 10000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase2-2000": {
    ingestion_snapshot_page_size: 2000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase2-5000": {
    ingestion_snapshot_page_size: 5000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
  "phase2-10000": {
    ingestion_snapshot_page_size: 10000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  },
});

const INGESTION_IMAGE =
  "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INGESTION_SOURCE_HASH = "a1b2c3d4e5f6".padEnd(64, "0");
const API_IMAGE =
  "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-api:a1b2c3d4e5f6";
const MYSQL_SNAPSHOT_IMAGE =
  "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad";

function postApplyState(preset) {
  const taskArn = (family) =>
    `arn:aws:ecs:us-east-1:111122223333:task-definition/${family}:8`;
  const task = (
    address,
    family,
    environment = [],
    containerImage = INGESTION_IMAGE,
    additionalContainers = [],
    primaryName = "ingestion",
  ) => ({
    address,
    mode: "managed",
    type: "aws_ecs_task_definition",
    name: address.split(".").at(-1),
    values: {
      arn: taskArn(family),
      container_definitions: JSON.stringify([
        { name: primaryName, image: containerImage, environment },
        ...additionalContainers,
      ]),
      ...(address === "aws_ecs_task_definition.api"
        ? {}
        : { ephemeral_storage: [{ size_in_gib: 200 }] }),
    },
  });
  const snapshotEnvironment = [
    { name: "PAGE_SIZE", value: String(UPDATE_PRESETS[preset].ingestion_snapshot_page_size) },
    {
      name: "MYSQL_SNAPSHOT_PREPARE_ENABLED",
      value: String(UPDATE_PRESETS[preset].ingestion_snapshot_prepare_enabled),
    },
    {
      name: "IMPORT_HOT_MATERIALIZATION_ENABLED",
      value: String(UPDATE_PRESETS[preset].import_hot_materialization_enabled),
    },
    { name: "INGESTION_DISK_BUDGET_BYTES", value: "68719476736" },
  ];
  const continuousEnvironment = [
    { name: "INGESTION_DISK_BUDGET_BYTES", value: "8589934592" },
  ];
  const incrementalIngestEnvironment = [
    { name: "INGESTION_DISK_BUDGET_BYTES", value: "17179869184" },
  ];
  const schedule = (address, family) => ({
    address,
    mode: "managed",
    type: "aws_scheduler_schedule",
    name: address.split(".").at(-1),
    values: {
      target: [
        {
          ecs_parameters: [{ task_definition_arn: taskArn(family) }],
        },
      ],
    },
  });

  return {
    values: {
      root_module: {
        resources: [
          {
            address: "terraform_data.ingestion_image[0]",
            mode: "managed",
            type: "terraform_data",
            name: "ingestion_image",
            values: { triggers_replace: [INGESTION_SOURCE_HASH] },
          },
          {
            address: "aws_ecr_repository.ingestion",
            mode: "managed",
            type: "aws_ecr_repository",
            name: "ingestion",
            values: {
              name: "view-show-ingestion",
              repository_url:
                "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion",
            },
          },
          {
            address: "data.aws_ecr_image.ingestion[0]",
            mode: "data",
            type: "aws_ecr_image",
            name: "ingestion",
            values: {
              repository_name: "view-show-ingestion",
              image_tag: "a1b2c3d4e5f6",
              image_digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
          task(
            "aws_ecs_task_definition.api",
            "view-show-api-task",
            [
              {
                name: "IMPORT_CANONICAL_FIRST_ENABLED",
                value: String(UPDATE_PRESETS[preset].import_canonical_first_enabled),
              },
              ...(UPDATE_PRESETS[preset].rate_limit_por_minuto
                ? [{
                    name: "RATE_LIMIT_PER_MINUTE",
                    value: String(UPDATE_PRESETS[preset].rate_limit_por_minuto),
                  }]
                : []),
            ],
            API_IMAGE,
            [],
            "view-show-iac-api",
          ),
          task(
            "aws_ecs_task_definition.ingestion_backfill",
            "view-show-ingestion-backfill",
            snapshotEnvironment,
            INGESTION_IMAGE,
            [
              { name: "tmp-owner", image: INGESTION_IMAGE, environment: [] },
              { name: "mysql-snapshot", image: MYSQL_SNAPSHOT_IMAGE, environment: [] },
            ],
          ),
          task(
            "aws_ecs_task_definition.ingestion_import",
            "view-show-ingestion-import",
            snapshotEnvironment,
            INGESTION_IMAGE,
            [
              { name: "tmp-owner", image: INGESTION_IMAGE, environment: [] },
              { name: "mysql-snapshot", image: MYSQL_SNAPSHOT_IMAGE, environment: [] },
            ],
          ),
          task(
            "aws_ecs_task_definition.ingestion_sync",
            "view-show-ingestion-sync",
            continuousEnvironment,
            INGESTION_IMAGE,
            [{ name: "tmp-owner", image: INGESTION_IMAGE, environment: [] }],
          ),
          task(
            "aws_ecs_task_definition.ingestion_incremental_export",
            "view-show-ingestion-incremental-export",
            continuousEnvironment,
            INGESTION_IMAGE,
            [{ name: "tmp-owner", image: INGESTION_IMAGE, environment: [] }],
          ),
          task(
            "aws_ecs_task_definition.ingestion_incremental_ingest",
            "view-show-ingestion-incremental-ingest",
            incrementalIngestEnvironment,
            INGESTION_IMAGE,
            [{ name: "tmp-owner", image: INGESTION_IMAGE, environment: [] }],
          ),
          schedule(
            "aws_scheduler_schedule.ingestion_sync",
            "view-show-ingestion-sync",
          ),
          schedule(
            "aws_scheduler_schedule.ingestion_incremental_export",
            "view-show-ingestion-incremental-export",
          ),
          schedule(
            "aws_scheduler_schedule.ingestion_incremental_ingest",
            "view-show-ingestion-incremental-ingest",
          ),
          {
            address: "aws_ecs_service.api",
            mode: "managed",
            type: "aws_ecs_service",
            name: "api",
            values: { task_definition: taskArn("view-show-api-task") },
          },
        ],
      },
    },
  };
}

function updatePlanJsonFromState(
  state,
  variables,
  {
    ingestionImage,
    ingestionHash,
    ecrUnknownMarker,
    ecrOmitsDigest,
    outputUnknownMarker,
    outputUnknownMarkerPresent,
    outputUsesNull,
    containerUnknownMarker,
  },
) {
  const resources = state?.values?.root_module?.resources ?? [];
  return {
    format_version: "1.2",
    terraform_version: "1.14.3",
    variables: Object.fromEntries(
      Object.entries(variables).map(([name, value]) => [name, { value }]),
    ),
    planned_values: {
      ...state.values,
      outputs: {
        imagem_ecr: { sensitive: false, type: "string", value: API_IMAGE },
        ingestion_runbook: {
          sensitive: false,
          type: "object",
          value: {
            image:
              ingestionImage === null && !outputUsesNull
                ? {}
                : { immutable_uri: ingestionImage },
          },
        },
      },
    },
    ...(ingestionImage === null
      ? {
          proposed_unknown: {
            outputs: {
              ingestion_runbook: {
                value: {
                  image: outputUnknownMarkerPresent
                    ? { immutable_uri: outputUnknownMarker }
                    : {},
                },
              },
            },
          },
        }
      : {}),
    resource_changes: resources
      .filter((resource) =>
        ["aws_ecs_task_definition", "aws_ecr_image", "terraform_data"].includes(
          resource.type,
        ),
      )
      .map((resource) => ({
        address: resource.address,
        mode: resource.mode,
        type: resource.type,
        name: resource.name,
        provider_name:
          resource.type === "terraform_data"
            ? "terraform.io/builtin/terraform"
            : "registry.terraform.io/hashicorp/aws",
        change: {
          actions: resource.type === "aws_ecr_image" ? ["read"] : ["update"],
          before: {},
          after:
            resource.type === "aws_ecr_image" && ingestionImage === null
              ? Object.fromEntries(
                  Object.entries({
                    ...resource.values,
                    image_digest: null,
                  }).filter(([name]) => !(ecrOmitsDigest && name === "image_digest")),
                )
              : resource.type === "terraform_data"
                ? { ...resource.values, triggers_replace: [ingestionHash] }
                : resource.values,
          after_unknown:
            resource.type === "aws_ecr_image" && ingestionImage === null
              ? { image_digest: ecrUnknownMarker }
              : resource.values.container_definitions === null
                ? { container_definitions: containerUnknownMarker }
                : {},
          before_sensitive: {},
          after_sensitive: {},
        },
      })),
    resource_drift: [],
    output_changes:
      ingestionImage === null
        ? {
            ingestion_runbook: {
              after: {
                image: outputUsesNull ? { immutable_uri: null } : {},
              },
              after_unknown: {
                image: outputUnknownMarkerPresent
                  ? { immutable_uri: outputUnknownMarker }
                  : {},
              },
            },
          }
        : {},
    prior_state: { terraform_version: "1.14.3", values: {} },
    configuration: { provider_config: {}, root_module: {} },
    relevant_attributes: [],
    checks: [],
    timestamp: "2026-09-21T12:34:56Z",
    applyable: true,
    complete: true,
    errored: false,
  };
}

function updateEnvironment({ preset = "phase1-5000", ...overrides } = {}) {
  const postApplyTerraformState =
    overrides.postApplyTerraformState ?? postApplyState(preset);
  const updatePlanTerraformState =
    overrides.updatePlanTerraformState ?? postApplyState(preset);
  return testEnvironment({
    root: ORIGINAL_ROOT,
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
    planVariableOverrides: UPDATE_PRESETS[preset],
    ...overrides,
    postApplyTerraformState,
    updatePlanTerraformState,
  });
}

test("help commands print usage and perform no infrastructure work", async () => {
  for (const step of [undefined, "help", "--help", "-h"]) {
    const a = testEnvironment();
    const result = await runLearnerLab({ ...a.options, step });

    assert.equal(result.status, 0, String(step));
    assert.deepEqual(a.calls, [], String(step));
    assert.match(a.logs.join("\n"), /usage:.*aws-learner-lab-ecs-legacy\.mjs/i);
    assert.match(a.logs.join("\n"), /check.*build-snapshot.*deploy.*seed.*evidence.*all/is);
  }
});

test("grafana starts a private SSM tunnel from validated Terraform outputs on every supported OS", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const a = testEnvironment({ platform });

    const result = await runLearnerLab({ ...a.options, step: "grafana" });

    assert.equal(result.status, 0, platform);
    assert.ok(a.logs.includes("Grafana URL: http://localhost:3002"), platform);
    assert.ok(a.logs.includes("Grafana user: admin"), platform);
    assert.ok(a.logs.includes("Grafana password: TestGrafanaPassword123"), platform);
    const tunnel = a.calls.find(
      (call) => call.command === "aws" && call.args[0] === "ssm" && call.args[1] === "start-session",
    );
    assert.deepEqual(tunnel?.args, [
      "ssm",
      "start-session",
      "--target",
      "i-0123456789abcdef0",
      "--document-name",
      "AWS-StartPortForwardingSession",
      "--parameters",
      "portNumber=3000,localPortNumber=3002",
      "--region",
      "us-east-1",
      "--profile",
      "default",
    ], platform);
    assert.equal(tunnel?.options.stdio, "inherit", platform);
  }
});

test("grafana --senha prints the local password without starting a tunnel", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({
    ...a.options,
    step: "grafana",
    extraArguments: ["--senha"],
  });

  assert.equal(result.status, 0);
  assert.ok(a.logs.includes("Grafana password: TestGrafanaPassword123"));
  assert.equal(
    a.calls.some((call) => call.command === "aws"),
    false,
  );
});

test("grafana provisions missing observability before opening the tunnel", async () => {
  const a = testEnvironment({ observabilityEndpoint: null, isTty: true });
  const confirmations = [];

  const result = await runLearnerLab({
    ...a.options,
    step: "grafana",
    confirm: async (phrase) => {
      confirmations.push(phrase);
      return true;
    },
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const plans = a.calls.filter(
    (call) => call.command === "terraform" && call.args.includes("plan"),
  );
  assert.equal(plans.length, 1);
  assert.ok(plans[0].args.includes("-var=observabilidade_habilitada=true"));
  assert.ok(a.calls.some(
    (call) => call.command === "terraform" && call.args.includes("apply"),
  ));
  assert.deepEqual(confirmations, ["PROVISION GRAFANA 111122223333"]);
  assert.ok(a.logs.includes("Infraestrutura: CREATED"));
});

test("grafana reuses healthy observability without planning", async () => {
  const a = testEnvironment({ isTty: true });

  const result = await runLearnerLab({ ...a.options, step: "grafana" });

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
  assert.ok(a.logs.includes("Infraestrutura: EXISTING"));
  assert.ok(a.logs.includes("Grafana: READY"));
  assert.ok(a.logs.includes("CloudWatch: READY"));
  assert.ok(a.logs.includes("Dashboard: view-show-ingestion"));
});

test("grafana reports optional Ollama and prints password only in a TTY", async () => {
  const interactive = testEnvironment({ isTty: true, analysisManifest: null });
  assert.equal(
    (await runLearnerLab({ ...interactive.options, step: "grafana" })).status,
    0,
    interactive.logs.join("\n"),
  );
  assert.ok(interactive.logs.includes("Grafana password: TestGrafanaPassword123"));
  assert.ok(interactive.logs.includes("Ollama/LLM: NOT_CONFIGURED"));

  const configured = testEnvironment({
    isTty: true,
    analysisManifest: { modelId: "qwen2.5:7b" },
  });
  assert.equal(
    (await runLearnerLab({ ...configured.options, step: "grafana" })).status,
    0,
    configured.logs.join("\n"),
  );
  assert.ok(configured.logs.includes("Ollama/LLM: CONFIGURED"));

  const automated = testEnvironment({ isTty: false, analysisManifest: null });
  assert.equal(
    (await runLearnerLab({ ...automated.options, step: "grafana" })).status,
    0,
    automated.logs.join("\n"),
  );
  assert.equal(
    automated.logs.some((line) => line.includes("TestGrafanaPassword123")),
    false,
  );
});

test("grafana never replaces an existing unhealthy instance", async () => {
  const a = testEnvironment({ grafanaHealthStatus: "Failed" });
  let clock = 0;

  const result = await runLearnerLab({
    ...a.options,
    step: "grafana",
    monotonic: () => {
      clock += 200;
      return clock;
    },
    sleep: async () => {},
  });

  assert.equal(result.status, 1);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
  assert.match(a.logs.join("\n"), /did not become healthy|health check failed/i);
});

test("analysis-bridge opens the private Ollama bridge without touching ECS on every supported OS", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const a = testEnvironment({ platform });
    const spawned = [];
    const killed = [];
    const result = await runLearnerLab({
      ...a.options,
      step: "analysis-bridge",
      readInput: async (prompt) => ({
        "Ollama SSH user: ": "student",
        "Ollama SSH host: ": "10.8.8.10",
        "Bastion key file: ": "/tmp/vockey.pem",
      })[prompt],
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, options });
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = (signal) => killed.push({ command, signal });
        return child;
      },
      waitForPort: async () => {},
      waitForBridgeStop: async (_children, stop) => stop(),
    });

    assert.equal(result.status, 0, a.logs.join("\n"));
    assert.deepEqual(spawned.map((entry) => entry.command), ["ssh", "aws", "ssh"], platform);
    assert.equal(a.calls.some((call) => call.args[0] === "ecs"), false, platform);
    assert.equal(killed.length, 3, platform);
    assert.ok(a.logs.some((line) => line.includes("Ollama bridge ready")), platform);
  }
});

test("setup deploys with the selected profile, creates a confirmed user and prints safe outputs", async () => {
  const a = testEnvironment({ environment: {} });
  const confirmations = [];
  const password = "SafePassword123!";

  const result = await runLearnerLab({
    ...a.options,
    step: "setup",
    extraArguments: ["--profile", "team-profile"],
    readInput: async () => "admin@example.com",
    readSecret: async () => password,
    confirmDeploy: async (summary) => {
      confirmations.push(summary);
      return true;
    },
  });

  assert.equal(result.status, 0);
  assert.equal(confirmations.length, 1);
  assert.doesNotMatch(String(confirmations[0]), /APPLY|DEPLOY/);
  const awsCalls = a.calls.filter(
    (call) => call.command === "aws" && call.args[0] !== "--version",
  );
  assert.ok(awsCalls.length > 0);
  assert.ok(
    awsCalls.every((call) =>
      call.args.includes("--profile") && call.args[call.args.indexOf("--profile") + 1] === "team-profile"
    ),
  );
  assert.ok(
    a.calls.some(
      (call) =>
        call.command === "aws" &&
        call.args[0] === "cognito-idp" &&
        call.args[1] === "admin-create-user",
    ),
  );
  assert.ok(
    a.calls.some(
      (call) =>
        call.command === "aws" &&
        call.args[0] === "cognito-idp" &&
        call.args[1] === "admin-set-user-password",
    ),
  );
  const terraformCalls = a.calls.filter((call) => call.command === "terraform");
  assert.ok(terraformCalls.length > 0);
  assert.ok(terraformCalls.every((call) => call.options.env?.AWS_PROFILE === "team-profile"));
  assert.equal(
    terraformCalls.some(
      (call) => call.args.includes("output") && call.args.at(-1) === "-json",
    ),
    false,
    "setup must not read every Terraform output because that includes sensitive values",
  );
  const observableText = JSON.stringify({ calls: a.calls, logs: a.logs });
  assert.doesNotMatch(observableText, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const output = a.logs.join("\n");
  assert.match(output, /view-show-fullstack/);
  assert.match(output, /https:\/\/example\.test/);
  assert.match(output, /https:\/\/api\.example\.test/);
  assert.match(output, /us-east-1_example/);
  assert.match(output, /client-example/);
  assert.match(output, /view-show-operacional/);
});

test("setup --yes skips confirmation but still provisions the initial Cognito user", async () => {
  const a = testEnvironment();
  let confirmationCount = 0;

  const result = await runLearnerLab({
    ...a.options,
    step: "setup",
    extraArguments: ["--yes"],
    readInput: async () => "admin@example.com",
    readSecret: async () => "SafePassword123!",
    confirmDeploy: async () => {
      confirmationCount += 1;
      return false;
    },
  });

  assert.equal(result.status, 0);
  assert.equal(confirmationCount, 0);
  assert.ok(
    a.calls.some(
      (call) => call.command === "aws" && call.args[1] === "admin-set-user-password",
    ),
  );
});

test("deploy creates and verifies the internal ingestion credential when its secret has no current version", async () => {
  const a = testEnvironment();
  const internalCredential = "internal-ingestion-credential-that-must-never-be-logged";
  const encodedCredential = Buffer.from(internalCredential).toString("base64url");
  const sensitiveWrites = [];
  let randomBytesCall = 0;

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    makeSensitiveTemporaryDirectory: () => path.join(os.tmpdir(), "view-show-test-ingestion"),
    writeSensitiveFile: (target, contents, options) =>
      sensitiveWrites.push({ target, contents: String(contents), options }),
    removeSensitiveFile: () => {},
    removeSensitiveDirectory: () => {},
    generateRandomBytes: () => {
      randomBytesCall += 1;
      return Buffer.from(
        randomBytesCall === 1 ? internalCredential : "independent-idempotency-token",
      );
    },
  });

  assert.equal(result.status, 0);
  assert.equal(sensitiveWrites.length, 1);
  assert.equal(sensitiveWrites[0].contents, encodedCredential);
  assert.deepEqual(sensitiveWrites[0].options, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const listCalls = a.calls.filter(
    (call) =>
      call.command === "aws" &&
      call.args[0] === "secretsmanager" &&
      call.args[1] === "list-secret-version-ids",
  );
  assert.equal(listCalls.length, 2, "the secret must be verified both before and after creation");
  const write = a.calls.find(
    (call) =>
      call.command === "aws" &&
      call.args[0] === "secretsmanager" &&
      call.args[1] === "put-secret-value",
  );
  assert.ok(write);
  assert.ok(write.args.includes("--secret-string"));
  assert.match(
    String(write.args[write.args.indexOf("--secret-string") + 1]),
    /^file:\/\//,
  );
  const observableText = JSON.stringify({ calls: a.calls, logs: a.logs });
  assert.doesNotMatch(observableText, new RegExp(encodedCredential));
  assert.match(a.logs.join("\n"), /internal ingestion credential is ready/i);
});

test("deploy reuses an existing internal ingestion credential without replacing it", async () => {
  const a = testEnvironment({ snapshotSecretHasCurrentVersion: true });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 0);
  assert.equal(
    a.calls.some(
      (call) =>
        call.command === "aws" &&
        call.args[0] === "secretsmanager" &&
        call.args[1] === "put-secret-value",
    ),
    false,
  );
  assert.match(a.logs.join("\n"), /internal ingestion credential is ready/i);
});

test("deploy fails closed when the internal ingestion credential cannot be created", async () => {
  const a = testEnvironment({ putSnapshotSecretFails: true });

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    makeSensitiveTemporaryDirectory: () => path.join(os.tmpdir(), "view-show-test-ingestion"),
    writeSensitiveFile: () => {},
    removeSensitiveFile: () => {},
    removeSensitiveDirectory: () => {},
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /could not create the internal ingestion credential/i);
});

test("setup retry updates an existing Cognito user without creating a duplicate", async () => {
  const a = testEnvironment({ cognitoUserExists: true });

  const result = await runLearnerLab({
    ...a.options,
    step: "setup",
    extraArguments: ["--yes"],
    readInput: async () => "admin@example.com",
    readSecret: async () => "ReplacementPassword123!",
  });

  assert.equal(result.status, 0);
  assert.equal(
    a.calls.some(
      (call) => call.command === "aws" && call.args[1] === "admin-create-user",
    ),
    false,
  );
  assert.ok(
    a.calls.some(
      (call) => call.command === "aws" && call.args[1] === "admin-set-user-password",
    ),
  );
  assert.match(a.logs.join("\n"), /admin@example\.com \(CONFIRMED\)/);
});

test("setup fails closed when the temporary password file cannot be removed", async () => {
  const a = testEnvironment({ snapshotSecretHasCurrentVersion: true });
  const removedDirectories = [];

  const result = await runLearnerLab({
    ...a.options,
    step: "setup",
    extraArguments: ["--yes"],
    readInput: async () => "admin@example.com",
    readSecret: async () => "SafePassword123!",
    makeSensitiveTemporaryDirectory: () => path.join(os.tmpdir(), "view-show-test-secret"),
    writeSensitiveFile: () => {},
    removeSensitiveFile: () => {
      throw new Error("locked");
    },
    removeSensitiveDirectory: (directory) => removedDirectories.push(directory),
  });

  assert.equal(result.status, 1);
  assert.equal(removedDirectories.length, 1);
  assert.match(a.logs.join("\n"), /temporary Cognito password file could not be removed/i);
});

test("setup rejects invalid flags before prompts or external calls", async () => {
  for (const extraArguments of [["--profile"], ["--unknown"], ["--profile", "nora"]]) {
    const a = testEnvironment();
    let promptCount = 0;
    const result = await runLearnerLab({
      ...a.options,
      step: "setup",
      extraArguments,
      readInput: async () => {
        promptCount += 1;
        return "admin@example.com";
      },
      readSecret: async () => {
        promptCount += 1;
        return "SafePassword123!";
      },
    });

    assert.equal(result.status, 2, extraArguments.join(" "));
    assert.equal(promptCount, 0, extraArguments.join(" "));
    assert.deepEqual(a.calls, [], extraArguments.join(" "));
  }
});

test("destroy plans the full Learner Lab stack and applies only after exact confirmation", async () => {
  const a = testEnvironment();
  const confirmations = [];

  const result = await runLearnerLab({
    ...a.options,
    step: "destroy",
    confirm: async (phrase) => {
      confirmations.push(phrase);
      return phrase === "DESTROY view-show-fullstack in account 111122223333";
    },
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.deepEqual(confirmations, ["DESTROY view-show-fullstack in account 111122223333"]);
  const plan = a.calls.find(
    (call) => call.command === "terraform" && call.args.includes("plan") && call.args.includes("-destroy"),
  );
  assert.ok(plan, "destroy must create a saved Terraform destroy plan");
  assert.ok(plan.args.includes("-var=force_destroy_bucket_ingestao=true"));
  assert.ok(plan.args.includes("-var=force_delete_ecr_ingestao=true"));
  const apply = a.calls.find(
    (call) => call.command === "terraform" && call.args.includes("apply"),
  );
  assert.ok(apply, "destroy must apply the confirmed saved destroy plan");
  assert.ok(a.calls.indexOf(plan) < a.calls.indexOf(apply));
  assert.equal(a.calls.some((call) => call.command === "docker"), false);
  assert.equal(a.calls.some((call) => call.command === "npm"), false);
  assert.equal(
    a.calls.some(
      (call) => call.command === "aws" && call.args.slice(0, 2).join(" ") === "ec2 describe-key-pairs",
    ),
    false,
  );
});

test("destroy never applies when the destructive confirmation is refused", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({
    ...a.options,
    step: "destroy",
    confirm: async () => false,
  });

  assert.equal(result.status, 1);
  assert.ok(
    a.calls.some(
      (call) => call.command === "terraform" && call.args.includes("plan") && call.args.includes("-destroy"),
    ),
  );
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("destroy rejects arguments before any AWS or Terraform call", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({
    ...a.options,
    step: "destroy",
    extraArguments: ["--yes"],
  });

  assert.equal(result.status, 2);
  assert.deepEqual(a.calls, []);
  assert.match(a.logs.join("\n"), /destroy does not accept extra arguments/i);
});

test("destroy fails closed outside the original checkout or configured region", async () => {
  for (const overrides of [
    { root: "/repo/worktree" },
    { environment: { AWS_PROFILE: "default", AWS_REGION: "sa-east-1" } },
  ]) {
    const a = testEnvironment(overrides);

    const result = await runLearnerLab({ ...a.options, step: "destroy" });

    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.deepEqual(a.calls, [], JSON.stringify(overrides));
  }
});

test("destroy permits a non-default AWS profile in the primary checkout", async () => {
  const a = testEnvironment({
    environment: { AWS_PROFILE: "nora", AWS_REGION: "us-east-1" },
  });

  const result = await runLearnerLab({ ...a.options, step: "destroy" });

  assert.equal(result.status, 0, a.logs.join("\n"));
});

test("a missing prerequisite stops before any mutating Terraform or AWS call", async () => {
  // Operators must not discover that Docker is unavailable halfway through apply.
  const a = testEnvironment({ missing: ["docker"] });
  const result = await runLearnerLab(a.options);

  assert.notEqual(result.status, 0);
  const mutatingCalls = a.calls.filter(
    (c) => c.command === "terraform" && c.args.some((x) => x === "apply" || x === "plan"),
  );
  assert.deepEqual(mutatingCalls, []);
  assert.ok(a.logs.join("\n").includes("docker"));
});

test("inactive credentials stop deployment even when every tool is installed", async () => {
  // get-caller-identity may outlive a cancelled session, so the active-policy
  // probe must fail before Terraform can mutate infrastructure.
  const a = testEnvironment({ credentialsActive: false });
  const result = await runLearnerLab(a.options);

  assert.notEqual(result.status, 0);
  const applied = a.calls.some(
    (c) => c.command === "terraform" && c.args.includes("apply"),
  );
  assert.equal(applied, false);
});

test("the workflow never passes --activate to run_task", async () => {
  // Candidate activation is a separate deliberate operation and cannot become
  // a side effect of the Learner Lab smoke workflow.
  const a = testEnvironment();
  await runLearnerLab(a.options);

  for (const call of a.calls) {
    assert.ok(!call.args.includes("--activate"), "the script must never activate a dataset");
  }
  const runTask = a.calls.find((c) => c.args.some((x) => String(x).includes("run_task")));
  assert.ok(runTask, "the complete workflow must launch the backfill");
  assert.ok(runTask.args.includes("--no-activate"));
});

test("the upload explicitly attests the reduced fixture extraction date", async () => {
  const a = testEnvironment();

  await runLearnerLab(a.options);

  const upload = a.calls.find((c) =>
    c.args.some((x) => String(x).includes("upload_snapshot.py")),
  );
  assert.ok(upload);
  const index = upload.args.indexOf("--snapshot-extracted-on");
  assert.ok(index >= 0);
  assert.equal(upload.args[index + 1], "2026-09-01");
});

test("the Windows platform uses the Windows virtual-environment executable", async () => {
  // The virtual-environment executable lives in a platform-specific directory.
  const unix = testEnvironment({ platform: "linux" });
  await runLearnerLab(unix.options);
  const windows = testEnvironment({ platform: "win32" });
  await runLearnerLab(windows.options);

  // Inspect the virtual-environment interpreter, not the system interpreter.
  const unixPath = unix.calls.find((c) => c.command.includes(".venv"))?.command ?? "";
  const windowsPath = windows.calls.find((c) => c.command.includes(".venv"))?.command ?? "";

  assert.ok(unixPath.includes(path.join(".venv", "bin")), unixPath);
  assert.ok(windowsPath.includes(path.join(".venv", "Scripts")), windowsPath);
  assert.ok(windowsPath.endsWith(".exe"), windowsPath);
});

test("terraform apply runs only after the create-only gate accepts the plan", async () => {
  const a = testEnvironment();
  await runLearnerLab(a.options);

  const indices = a.calls.map((c, i) => ({ c, i }));
  const gate = indices.find(({ c }) =>
    c.args.some((x) => String(x).includes("validate-create-plan")),
  );
  const apply = indices.find(({ c }) => c.command === "terraform" && c.args.includes("apply"));
  assert.ok(gate, "the create-only gate must run");
  assert.ok(apply, "terraform apply must run");
  assert.ok(gate.i < apply.i, "the gate must run before apply");
});

test("deploy prints the operational summary and stops when confirmation is refused", async () => {
  const a = testEnvironment();
  const confirmations = [];

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    confirm: (phrase) => {
      confirmations.push(phrase);
      return false;
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(confirmations, ["Deploy view-show-fullstack in account 111122223333?"]);
  assert.equal(
    a.calls.some((c) => c.command === "terraform" && c.args.includes("apply")),
    false,
  );
  const output = a.logs.join("\n");
  assert.match(output, /AWS account:\s+111122223333/);
  assert.match(output, /Region:\s+us-east-1/);
  assert.match(output, /Profile:\s+default/i);
  assert.match(output, /Scope:\s+network, API, frontend and ingestion/i);
  assert.match(output, /Workspace:\s+default/i);
  assert.match(output, /Bastion:.*SSH DISABLED/i);
  assert.match(output, /LGTM on EC2:\s+DISABLED/i);
  assert.match(output, /Scheduler:\s+DISABLED/);
  assert.doesNotMatch(output, /Live sync:/);
  assert.match(output, /Plan policy:\s+create\/no-op only/i);
  assert.match(output, /State:\s+apps[/\\]fullstack[/\\]terraform\.tfstate/);
});

test("deploy seeds the Scheduler disabled without a live-sync Terraform variable", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 0);
  const plan = a.calls.find(
    (call) => call.command === "terraform" && call.args.includes("plan"),
  );
  assert.ok(plan);
  assert.ok(plan.args.includes("-var=scheduler_ingestao_habilitado=false"));
  assert.ok(!plan.args.includes("-var=live_sync_enabled=false"));
  assert.ok(plan.args.includes("-var=ambiente=learner-lab"));
  assert.ok(plan.args.includes("-var=observabilidade_habilitada=false"));
  assert.ok(plan.args.includes("-var=bedrock_habilitado=false"));
  assert.ok(plan.args.includes("-var=bastion_key_name=vockey"));
  assert.ok(plan.args.includes("-var=tipo_instancia_bastion=t3.micro"));
  assert.ok(plan.args.includes("-var=cpu_task=256"));
  assert.ok(plan.args.includes("-var=memoria_task=512"));
  assert.ok(plan.args.includes("-var=quantidade_tasks=1"));
  assert.ok(plan.args.includes("-var=ingestion_backfill_cpu=2048"));
  assert.ok(plan.args.includes("-var=ingestion_backfill_memoria=8192"));
  assert.ok(plan.args.includes("-var=ingestion_backfill_ephemeral_storage_gib=200"));
  assert.ok(plan.args.includes("-var=ingestion_sync_cpu=1024"));
  assert.ok(plan.args.includes("-var=ingestion_sync_memoria=2048"));
});

test("an installed interpreter is rejected when it is not Python 3.12", async () => {
  const a = testEnvironment({ pythonVersion: "Python 3.13.2", venvVersion: "Python 3.13.2" });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /python 3\.12/i);
  assert.equal(
    a.calls.some((c) => c.command === "terraform" && c.args.includes("apply")),
    false,
  );
});

test("an existing Python 3.12 venv is accepted when system Python differs", async () => {
  const a = testEnvironment({ pythonVersion: "Python 3.13.2", venvVersion: "Python 3.12.11" });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.ok(
    a.calls.some(
      (c) => c.command.includes(".venv") && c.args.some((x) => String(x).includes("build_reduced_snapshot.py")),
    ),
  );
});

test("an existing venv with the wrong Python version is never used silently", async () => {
  const a = testEnvironment({ pythonVersion: "Python 3.12.11", venvVersion: "Python 3.13.2" });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /python 3\.12/i);
  assert.equal(
    a.calls.some((c) => c.args.some((x) => String(x).includes("build_reduced_snapshot.py"))),
    false,
  );
});

const SERVICE_DIRECTORY = path.join(ROOT, "apps", "backend", "ingestion-data");
const editableInstalls = (calls) => calls.filter((c) => c.args.includes("--editable"));

test("a new venv gets the ingestion package after its dependencies", async () => {
  const a = testEnvironment({ venvExists: false, ingestionPackageInstalled: false });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  const requirements = a.calls.findIndex((c) => c.args.includes("-r"));
  const [install] = editableInstalls(a.calls);
  assert.ok(install, "the ingestion package was never installed");
  assert.deepEqual(install.args.slice(-4), ["--quiet", "--no-deps", "--editable", SERVICE_DIRECTORY]);
  assert.ok(a.calls.indexOf(install) > requirements, "the package must follow the dependencies");
});

test("an existing venv without the ingestion package is repaired, not recreated", async () => {
  const a = testEnvironment({ venvExists: true, ingestionPackageInstalled: false });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.equal(editableInstalls(a.calls).length, 1);
  assert.equal(
    a.calls.some((c) => c.args.slice(0, 2).join(" ") === "-m venv"),
    false,
  );
  assert.match(a.logs.join("\n"), /Installing the ingestion package/);
});

test("a venv that already has the ingestion package is left untouched", async () => {
  const a = testEnvironment({ venvExists: true, ingestionPackageInstalled: true });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.equal(editableInstalls(a.calls).length, 0);
});

test("the package probe ignores the current directory", async () => {
  const a = testEnvironment({ venvExists: true });

  await runLearnerLab({ ...a.options, step: "build-snapshot" });

  const probe = a.calls.find((c) => c.command.includes(".venv") && c.args.includes("-c"));
  assert.ok(probe, "the package probe never ran");
  assert.equal(probe.args[0], "-I");
});

test("a failed package install stops before the snapshot is built", async () => {
  const a = testEnvironment({
    venvExists: true,
    ingestionPackageInstalled: false,
    ingestionPackageInstallStatus: 1,
  });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /could not install the ingestion package/);
  assert.equal(
    a.calls.some((c) => c.args.some((x) => String(x).includes("build_reduced_snapshot.py"))),
    false,
  );
});

test("credentials outside the Learner Lab voclabs role are rejected", async () => {
  const a = testEnvironment({
    identityArn: "arn:aws:sts::111122223333:assumed-role/Administrator/local-user",
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /voclabs|Learner Lab/i);
  assert.equal(
    a.calls.some((c) => c.command === "terraform" && c.args.includes("apply")),
    false,
  );
});

test("build-snapshot stays local and does not require Terraform, Docker or AWS", async () => {
  const a = testEnvironment({ missing: ["terraform", "docker", "aws"] });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.equal(a.calls.some((c) => ["terraform", "docker", "aws"].includes(c.command)), false);
  assert.ok(
    a.calls.some((c) =>
      c.args.some((x) => String(x).includes("build_reduced_snapshot.py")),
    ),
  );
});

test("English commands route to their intended operations", async () => {
  const cases = [
    ["check", (calls) => calls.some((c) => c.command === "aws" && c.args[0] === "sts")],
    [
      "build-snapshot",
      (calls) =>
        calls.some((c) =>
          c.args.some((value) => String(value).includes("build_reduced_snapshot.py")),
        ),
    ],
    [
      "deploy",
      (calls) => calls.some((c) => c.command === "terraform" && c.args.includes("apply")),
    ],
    [
      "seed",
      (calls) =>
        calls.some((c) => c.args.some((value) => String(value).includes("run_task.py"))),
    ],
    [
      "evidence",
      (calls) =>
        calls.some(
          (c) => c.command === "aws" && c.args.slice(0, 2).join(" ") === "dynamodb scan",
        ),
    ],
    [
      "all",
      (calls) =>
        calls.some((c) => c.command === "terraform" && c.args.includes("apply")) &&
        calls.some((c) => c.args.some((value) => String(value).includes("run_task.py"))),
    ],
  ];

  for (const [step, exercisedExpectedOperation] of cases) {
    const a = testEnvironment();
    const result = await runLearnerLab({ ...a.options, step });

    assert.equal(result.status, 0, step);
    assert.equal(exercisedExpectedOperation(a.calls), true, step);
  }
});

test("Portuguese command names are rejected instead of maintaining two public interfaces", async () => {
  for (const step of ["verificar", "gerar", "provisionar", "semear", "evidencias", "tudo"]) {
    const a = testEnvironment();

    const result = await runLearnerLab({ ...a.options, step });

    assert.equal(result.status, 2, step);
    assert.deepEqual(a.calls, [], step);
    assert.match(a.logs.join("\n"), /unknown command/i, step);
  }
});

test("deploy creates the private plan directory before terraform plan", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 0);
  assert.deepEqual(a.directories, [
    {
      directory: path.join(ROOT, "apps", "fullstack", ".terraform-artifacts"),
      options: { recursive: true, mode: 0o700 },
    },
  ]);
});

test("all completes only after ECS polling observes STOPPED and the durable run is SUCCEEDED", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 0);
  const runTaskIndex = a.calls.findIndex((c) =>
    c.args.some((x) => String(x).includes("run_task.py")),
  );
  const describeIndex = a.calls.findIndex(
    (c) => c.command === "aws" && c.args.slice(0, 2).join(" ") === "ecs describe-tasks",
  );
  const durableRunIndex = a.calls.findIndex(
    (c) => c.command === "aws" && c.args.slice(0, 2).join(" ") === "dynamodb get-item",
  );
  assert.ok(
    runTaskIndex >= 0 && describeIndex > runTaskIndex && durableRunIndex > describeIndex,
  );
  assert.equal(
    a.calls.some(
      (c) => c.command === "aws" && c.args.slice(0, 3).join(" ") === "ecs wait tasks-stopped",
    ),
    false,
  );
  assert.match(a.logs.join("\n"), /SUCCEEDED/);
});

function configuredSeedArguments(snapshot = "/tmp/argus_dump.sql.gz") {
  return [
    "--snapshot",
    snapshot,
    "--extracted-on",
    "2026-09-01",
    "--label",
    "phase1-100k",
    "--timeout-seconds",
    "21600",
  ];
}

function taskDescription(status, exitCode = 0) {
  return {
    status: 0,
    stdout: JSON.stringify({
      failures: [],
      tasks: [
        {
          taskArn: "arn:aws:ecs:us-east-1:111122223333:task/view-show/task-1",
          lastStatus: status,
          containers: [
            { name: "ingestion", lastStatus: status, exitCode },
            { name: "mysql-snapshot", lastStatus: status, exitCode },
          ],
        },
      ],
    }),
    stderr: "",
  };
}

test("configured seed validates locally and passes exact snapshot provenance and evidence paths", async () => {
  const a = testEnvironment();
  const snapshot = "/tmp/argus_dump.sql.gz";

  const result = await runLearnerLab({
    ...a.options,
    step: "seed",
    extraArguments: configuredSeedArguments(snapshot),
    accessFile: () => {},
  });

  assert.equal(result.status, 0);
  const upload = a.calls.find((call) =>
    call.args.some((value) => String(value).includes("upload_snapshot.py")),
  );
  assert.deepEqual(upload.args, [
    path.join(ROOT, "apps", "backend", "ingestion-data", "scripts", "upload_snapshot.py"),
    snapshot,
    "--bucket",
    "view-show-ingestion-111122223333-us-east-1",
    "--account-id",
    "111122223333",
    "--region",
    "us-east-1",
    "--snapshot-extracted-on",
    "2026-09-01",
    "--output",
    path.join(
      ROOT,
      ".artifacts",
      "argus-benchmarks",
      "upload-result-phase1-100k.json",
    ),
  ]);
  const launched = a.calls.find((call) =>
    call.args.some((value) => String(value).includes("run_task.py")),
  );
  assert.deepEqual(launched.args, [
    path.join(ROOT, "apps", "backend", "ingestion-data", "scripts", "run_task.py"),
    "--terraform-output",
    path.join(
      ROOT,
      ".artifacts",
      "argus-benchmarks",
      "terraform-output-phase1-100k.json",
    ),
    "--snapshot",
    path.join(
      ROOT,
      ".artifacts",
      "argus-benchmarks",
      "upload-result-phase1-100k.json",
    ),
    "--launch-attempt",
    "phase1-100k-2026-09-21T12-34-56-789Z",
    "--no-activate",
  ]);
  for (const call of a.calls.filter(
    ({ command, args }) => command === "aws" && args[0] !== "--version",
  )) {
    assert.deepEqual(call.args.slice(-2), ["--profile", "default"]);
    assert.equal(call.args.includes("nora"), false);
  }
});

test("configured seed rejects incomplete, unknown, malformed and unsafe inputs before AWS", async () => {
  const cases = [
    [["--snapshot", "/tmp/argus_dump.sql.gz"], /all four|requires/i, {}],
    [[...configuredSeedArguments(), "--unknown", "value"], /unknown/i, {}],
    [configuredSeedArguments("/tmp/argus.sql"), /\.sql\.gz/i, {}],
    [
      configuredSeedArguments().map((value) => (value === "2026-09-01" ? "2026-02-30" : value)),
      /date|extracted/i,
      {},
    ],
    [
      configuredSeedArguments().map((value) => (value === "phase1-100k" ? "Phase_1" : value)),
      /label/i,
      {},
    ],
    [
      configuredSeedArguments().map((value) => (value === "21600" ? "59" : value)),
      /timeout/i,
      {},
    ],
    [
      configuredSeedArguments(),
      /regular|symlink/i,
      { lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }) },
    ],
    [
      configuredSeedArguments(),
      /readable|read/i,
      { accessFile: () => { throw new Error("EACCES"); } },
    ],
  ];

  for (const [extraArguments, expectedMessage, overrides] of cases) {
    const a = testEnvironment();
    const result = await runLearnerLab({
      ...a.options,
      step: "seed",
      extraArguments,
      accessFile: () => {},
      ...overrides,
    });

    assert.notEqual(result.status, 0);
    assert.match(a.logs.join("\n"), expectedMessage);
    assert.equal(a.calls.some((call) => call.command === "aws"), false);
  }
});

test("seed polling sleeps fifteen seconds and supports long running tasks", async () => {
  const a = testEnvironment();
  const originalExecute = a.options.execute;
  const statuses = ["PENDING", "RUNNING", "STOPPED"];
  const sleeps = [];
  const result = await runLearnerLab({
    ...a.options,
    step: "seed",
    extraArguments: configuredSeedArguments(),
    accessFile: () => {},
    execute: (command, args, options) => {
      const base = originalExecute(command, args, options);
      if (command === "aws" && args.slice(0, 2).join(" ") === "ecs describe-tasks") {
        return taskDescription(statuses.shift());
      }
      return base;
    },
    monotonic: (() => {
      const values = [100, 101, 116];
      return () => values.shift();
    })(),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(result.status, 0);
  assert.deepEqual(sleeps, [15_000, 15_000]);
  assert.equal(statuses.length, 0);
});

test("seed timeout uses a monotonic deadline and returns the live task without stopping it", async () => {
  const a = testEnvironment();
  const originalExecute = a.options.execute;
  const monotonicValues = [50, 110];
  const sleeps = [];
  const result = await runLearnerLab({
    ...a.options,
    step: "seed",
    extraArguments: configuredSeedArguments().map((value) =>
      value === "21600" ? "60" : value,
    ),
    accessFile: () => {},
    execute: (command, args, options) => {
      const base = originalExecute(command, args, options);
      if (command === "aws" && args.slice(0, 2).join(" ") === "ecs describe-tasks") {
        return taskDescription("RUNNING");
      }
      return base;
    },
    monotonic: () => monotonicValues.shift(),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(result.status, 0);
  assert.equal(result.timedOut, true);
  assert.equal(
    result.taskArn,
    "arn:aws:ecs:us-east-1:111122223333:task/view-show/task-1",
  );
  assert.deepEqual(sleeps, []);
  assert.equal(
    a.calls.some((call) => call.command === "aws" && call.args[0] === "ecs" && call.args[1] === "stop-task"),
    false,
  );
  assert.equal(
    a.calls.some(
      (call) => call.command === "aws" && call.args.slice(0, 2).join(" ") === "dynamodb get-item",
    ),
    false,
  );
  assert.match(a.logs.join("\n"), /timed out|evidence|task.*running/i);
});

test("all fails when an essential ECS container exits non-zero", async () => {
  const a = testEnvironment({ taskExitCode: 1 });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /exit code|container/i);
});

test("all fails when the durable run does not end in SUCCEEDED", async () => {
  const a = testEnvironment({ runStage: "FAILED" });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /FAILED/);
});

test("preflight enforces the documented Terraform, Node and AWS CLI versions", async () => {
  const cases = [
    [{ terraformVersion: "1.6.6" }, /Terraform 1\.7/i],
    [{ terraformVersion: "2.0.0" }, /Terraform 1\.7/i],
    [{ nodeVersion: "v20.19.0" }, /Node\.js 22/i],
    [{ nodeVersion: "v23.11.0" }, /Node\.js 22/i],
    [{ awsCliVersion: "aws-cli/1.44.0 Python/3.11.9" }, /AWS CLI v2/i],
  ];

  for (const [configuration, expectedMessage] of cases) {
    const a = testEnvironment(configuration);
    const result = await runLearnerLab({ ...a.options, step: "deploy" });

    assert.equal(result.status, 1);
    assert.match(a.logs.join("\n"), expectedMessage);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
      false,
    );
  }
});

test("unsupported Node version reports the detected version and how to select Node 22", async () => {
  const a = testEnvironment({ nodeVersion: "v24.19.0" });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });
  const output = a.logs.join("\n");

  assert.equal(result.status, 1);
  assert.match(output, /detected v24\.19\.0/i);
  assert.match(output, /nvm install 22/);
  assert.match(output, /nvm use 22/);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("preflight accepts the lower supported Terraform and Node boundaries", async () => {
  const a = testEnvironment({ terraformVersion: "1.7.0", nodeVersion: "v22.0.0" });

  const result = await runLearnerLab({ ...a.options, step: "check" });

  assert.equal(result.status, 0);
});

test("preflight accepts AWS CLI v2 version output from stdout or stderr", async () => {
  for (const awsCliVersionStream of ["stdout", "stderr"]) {
    const a = testEnvironment({ awsCliVersionStream });

    const result = await runLearnerLab({ ...a.options, step: "check" });

    assert.equal(result.status, 0, awsCliVersionStream);
  }
});

test("malformed tool versions fail closed before Terraform planning", async () => {
  for (const configuration of [
    { terraformVersion: "not-a-version" },
    { nodeVersion: "development-build" },
    { awsCliVersion: "aws-cli/development" },
    { npmVersion: "development" },
  ]) {
    const a = testEnvironment(configuration);

    const result = await runLearnerLab({ ...a.options, step: "deploy" });

    assert.equal(result.status, 1, JSON.stringify(configuration));
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
      false,
    );
  }
});

test("deploy requires npm before Terraform can create a plan", async () => {
  const a = testEnvironment({ missing: ["npm"] });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /npm/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("deploy verifies the vockey key pair before Terraform can create a plan", async () => {
  const a = testEnvironment({ keyPairExists: false });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /vockey/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("an empty key-pair response is rejected even when AWS exits successfully", async () => {
  const a = testEnvironment({ keyPairPayload: { KeyPairs: [] } });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /vockey/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("deploy rejects hidden Terraform overrides without printing their values", async () => {
  const secretValue = "should-never-appear";
  const a = testEnvironment({
    environment: {
      TF_VAR_bastion_admin_cidr: secretValue,
      TF_CLI_ARGS_plan: "-target=aws_instance.bastion",
    },
  });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  const output = a.logs.join("\n");
  assert.match(output, /TF_VAR_bastion_admin_cidr/);
  assert.match(output, /TF_CLI_ARGS_plan/);
  assert.doesNotMatch(output, new RegExp(secretValue));
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("init")),
    false,
  );
});

test("Windows rejects hidden Terraform overrides regardless of environment-key casing", async () => {
  const a = testEnvironment({
    platform: "win32",
    environment: { Tf_Cli_Args_PlAn: "-target=aws_instance.bastion" },
  });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /Tf_Cli_Args_PlAn/);
  assert.equal(a.calls.length, 0);
});

test("deploy rejects automatically loaded local Terraform variable files", async () => {
  for (const filename of [
    "terraform.tfvars",
    "terraform.tfvars.json",
    "local.auto.tfvars",
    "local.auto.tfvars.json",
  ]) {
    const a = testEnvironment({ localTerraformFiles: [filename] });

    const result = await runLearnerLab({ ...a.options, step: "deploy" });

    assert.equal(result.status, 1, filename);
    assert.match(a.logs.join("\n"), new RegExp(filename.replaceAll(".", "\\.")), filename);
    assert.equal(a.calls.length, 0, filename);
  }
});

test("Windows rejects automatic Terraform variable files regardless of filename casing", async () => {
  const a = testEnvironment({
    platform: "win32",
    localTerraformFiles: ["Terraform.Tfvars", "LOCAL.Auto.Tfvars.Json"],
  });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /Terraform\.Tfvars/);
  assert.match(a.logs.join("\n"), /LOCAL\.Auto\.Tfvars\.Json/);
  assert.equal(a.calls.length, 0);
});

test("deploy requires the default Terraform workspace before planning", async () => {
  const a = testEnvironment({ terraformWorkspace: "experiment" });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /workspace.*default/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("seed refuses to read outputs from a non-default Terraform workspace", async () => {
  const a = testEnvironment({ terraformWorkspace: "experiment" });

  const result = await runLearnerLab({ ...a.options, step: "seed" });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /workspace.*default/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("output")),
    false,
  );
});

test("a saved plan outside the safe Learner Lab profile never reaches confirmation", async () => {
  const a = testEnvironment({ planVariableOverrides: { quantidade_tasks: 4 } });
  let confirmations = 0;

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /safe Learner Lab profile.*quantidade_tasks/i);
  assert.equal(confirmations, 0);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("a rejected create-only gate prevents confirmation and apply", async () => {
  const a = testEnvironment({ gateAccepted: false });
  let confirmations = 0;

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, 1);
  assert.equal(confirmations, 0);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("POSIX runs tighten permissions even when artifact paths already exist", async () => {
  const a = testEnvironment({ platform: "linux" });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 0);
  assert.deepEqual(a.permissions, [
    { target: path.join(ROOT, "apps", "fullstack", ".terraform-artifacts"), mode: 0o700 },
    {
      target: path.join(
        ROOT,
        "apps",
        "fullstack",
        ".terraform-artifacts",
        "view-show.tfplan",
      ),
      mode: 0o600,
    },
    { target: path.join(ROOT, "terraform-output.json"), mode: 0o600 },
    { target: path.join(ROOT, "upload-result.json"), mode: 0o600 },
  ]);
});

test("confirmation text must match exactly", () => {
  assert.equal(isExactConfirmation("APPLY view-show", "APPLY view-show"), true);
  assert.equal(isExactConfirmation(" APPLY view-show", "APPLY view-show"), false);
  assert.equal(isExactConfirmation("APPLY view-show ", "APPLY view-show"), false);
  assert.equal(isExactConfirmation("APPLY view-show\n", "APPLY view-show"), false);
  assert.equal(isExactConfirmation("apply view-show", "APPLY view-show"), false);
});

test("POSIX discovery prefers an explicit Python 3.12 executable", async () => {
  const a = testEnvironment({
    venvExists: false,
    pythonVersion: "Python 3.13.2",
    pythonCommandVersions: { "python3.12": "Python 3.12.11" },
  });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.equal(
    a.calls.some(
      (call) => call.command === "python3.12" && call.args.slice(0, 2).join(" ") === "-m venv",
    ),
    true,
  );
});

test("Windows discovery uses the Python 3.12 launcher selector", async () => {
  const a = testEnvironment({
    platform: "win32",
    venvExists: false,
    pythonVersion: "Python 3.13.2",
    pythonCommandVersions: { "py -3.12": "Python 3.12.11" },
  });

  const result = await runLearnerLab({ ...a.options, step: "build-snapshot" });

  assert.equal(result.status, 0);
  assert.equal(
    a.calls.some(
      (call) =>
        call.command === "py" && call.args.slice(0, 3).join(" ") === "-3.12 -m venv",
    ),
    true,
  );
});

test("permission hardening failure stops before Terraform apply", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({
    ...a.options,
    step: "deploy",
    changeMode: () => {
      throw new Error("chmod denied");
    },
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /chmod denied/);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("Windows leaves artifact access control to the inherited workspace ACL", async () => {
  const a = testEnvironment({ platform: "win32" });

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 0);
  assert.deepEqual(a.permissions, []);
  assert.equal(
    a.calls.some(
      (call) =>
        call.command === "cmd.exe" &&
        call.args.join(" ") === "/d /s /c npm --version",
    ),
    true,
  );
});

test("update initializes the internal ingestion credential only after applying its validated plan", async () => {
  const a = updateEnvironment({ preset: "baseline" });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "baseline",
    confirm: async () => true,
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const applyIndex = a.calls.findIndex(
    (call) => call.command === "terraform" && call.args.includes("apply"),
  );
  const createSecretIndex = a.calls.findIndex(
    (call) =>
      call.command === "aws" &&
      call.args[0] === "secretsmanager" &&
      call.args[1] === "put-secret-value",
  );
  assert.ok(applyIndex >= 0);
  assert.ok(createSecretIndex > applyIndex);
});

test("update presets are hardcoded and the validated saved plan is the only apply input", async () => {
  for (const [preset, expected] of Object.entries(UPDATE_PRESETS)) {
    const a = updateEnvironment({ preset });
    const confirmations = [];
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset,
      confirm: async (phrase) => {
        confirmations.push(phrase);
        return true;
      },
    });

    assert.equal(result.status, 0, `${preset}: ${a.logs.join("\n")}`);
    assert.deepEqual(confirmations, [`UPDATE view-show 111122223333 ${preset}`]);
    const plan = a.calls.find(
      (call) => call.command === "terraform" && call.args.includes("plan"),
    );
    assert.ok(plan, preset);
    assert.ok(
      plan.args.includes(
        `-var=ingestion_snapshot_page_size=${expected.ingestion_snapshot_page_size}`,
      ),
    );
    assert.ok(
      plan.args.includes(
        `-var=ingestion_snapshot_prepare_enabled=${expected.ingestion_snapshot_prepare_enabled}`,
      ),
    );
    assert.ok(
      plan.args.includes(
        `-var=import_canonical_first_enabled=${expected.import_canonical_first_enabled}`,
      ),
    );
    assert.ok(
      plan.args.includes(
        `-var=import_hot_materialization_enabled=${expected.import_hot_materialization_enabled}`,
      ),
    );
    assert.ok(plan.args.includes("-var=import_canonical_first_production_approved=false"));
    const gate = a.calls.find(
      (call) =>
        call.command === "node" &&
        call.args.some((arg) =>
          String(arg).includes("validate-learner-update-plan"),
        ),
    );
    assert.ok(gate, preset);
    assert.equal(gate.args.at(-1), preset);
    assert.doesNotThrow(() => JSON.parse(gate.options.input));
    const apply = a.calls.find(
      (call) => call.command === "terraform" && call.args.includes("apply"),
    );
    const show = a.calls.find(
      (call) =>
        call.command === "terraform" &&
        call.args.includes("show") &&
        call.args.some((arg) => String(arg).includes("/proc/self/fd/")),
    );
    const planPath = plan.args.find((arg) => String(arg).startsWith("-out=")).slice(5);
    assert.notEqual(planPath, apply.args.at(-1));
    assert.equal(show.args.at(-1), "/proc/self/fd/3");
    assert.equal(apply.args.at(-1), "/proc/self/fd/3");
    assert.equal(show.options.stdio[3], apply.options.stdio[3]);
    assert.ok(Number.isInteger(apply.options.stdio[3]));
    assert.equal(
      a.calls.filter(
        (call) => call.command === "terraform" && call.args.includes("plan"),
      ).length,
      1,
    );
  }
});

test("plan-update uses the protected plan reference supported by each POSIX operating system", async () => {
  for (const [platform, expectedReference] of [
    ["linux", "/proc/self/fd/3"],
    ["darwin", "/dev/fd/3"],
  ]) {
    const a = updateEnvironment({ platform });

    const result = await runLearnerLab({
      ...a.options,
      step: "plan-update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 0, `${platform}: ${a.logs.join("\n")}`);
    const plan = a.calls.find(
      (call) => call.command === "terraform" && call.args.includes("plan"),
    );
    const planPath = plan.args.find((argument) => String(argument).startsWith("-out=")).slice(5);
    const shown = a.calls.find(
      (call) =>
        call.command === "terraform" &&
        call.args.includes("show") &&
        call.args.includes("-json"),
    );
    assert.notEqual(shown.args.at(-1), planPath, platform);
    assert.equal(shown.args.at(-1), expectedReference, platform);
    assert.equal(shown.options.stdio.length, 4, platform);
  }
});

test("plan-update validates a saved plan but never confirms, backs up, or applies", async () => {
  const a = updateEnvironment();
  let confirmations = 0;
  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(confirmations, 0);
  assert.deepEqual(a.copies, []);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("two update plans for the same preset use distinct private artifacts", async () => {
  const a = updateEnvironment();
  for (let run = 0; run < 2; run += 1) {
    const result = await runLearnerLab({
      ...a.options,
      step: "plan-update",
      preset: "phase1-5000",
    });
    assert.equal(result.status, 0, a.logs.join("\n"));
  }

  const planPaths = a.calls
    .filter((call) => call.command === "terraform" && call.args.includes("plan"))
    .map((call) => call.args.find((arg) => String(arg).startsWith("-out=")).slice(5));
  assert.equal(new Set(planPaths).size, 2);
  assert.equal(a.temporaryDirectories.length, 2);
  assert.deepEqual(a.closedPlanDescriptors, a.planDescriptors);
  for (const planPath of planPaths) {
    assert.match(planPath, /[/\\]\.terraform-artifacts[/\\]update-phase1-5000-/);
    assert.doesNotMatch(planPath, /[/\\]\.artifacts[/\\]/);
  }
});

test("update rejects a plan whose bytes change after validation and never applies it", async () => {
  for (const platform of ["linux"]) {
    const a = updateEnvironment({
      platform,
      replacementPlanBytes: Buffer.from("different terraform plan bytes"),
    });
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 1, platform);
    assert.match(a.logs.join("\n"), /integrity|changed/i, platform);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
      false,
      platform,
    );
  }
});

test("Windows update fails closed before Terraform can show or apply a saved plan", async () => {
  const a = updateEnvironment({ platform: "win32" });
  a.options.currentUserId = () => undefined;

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1, a.logs.join("\n"));
  assert.equal(
    a.calls.some(
      (call) =>
        call.command === "terraform" &&
        (call.args.includes("plan") || call.args.includes("apply")),
    ),
    false,
  );
  assert.match(a.logs.join("\n"), /unsupported platform for protected Terraform plans/i);
});

test("update never applies a plan whose filesystem identity is unavailable", async () => {
  const a = updateEnvironment();
  const inspect = a.options.inspectArtifactPath;
  a.options.inspectArtifactPath = (target) => {
    const metadata = inspect(target);
    if (!String(target).endsWith(".tfplan")) return metadata;
    return { ...metadata, dev: undefined, ino: undefined };
  };

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("exclusive update artifacts are removed after success, cancellation, and errors", async () => {
  const cases = [
    {
      label: "success",
      configure: {},
      confirm: async () => true,
      expectedStatus: 0,
    },
    {
      label: "cancelled",
      configure: {},
      confirm: async () => false,
      expectedStatus: 1,
    },
    {
      label: "error",
      configure: { updateGateAccepted: false },
      confirm: async () => true,
      expectedStatus: 1,
    },
  ];

  for (const scenario of cases) {
    const a = updateEnvironment(scenario.configure);
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
      confirm: scenario.confirm,
    });

    assert.equal(result.status, scenario.expectedStatus, scenario.label);
    assert.equal(
      [...a.artifactEntries.keys()].filter((entry) => entry.includes("update-phase1-5000-"))
        .length,
      0,
      scenario.label,
    );
    assert.equal(a.removedArtifactFiles.length, 1, scenario.label);
    assert.equal(a.removedArtifactDirectories.length, 1, scenario.label);
    assert.equal(
      path.dirname(a.removedArtifactFiles[0]),
      a.removedArtifactDirectories[0],
      scenario.label,
    );
    assert.ok(
      a.artifactLifecycle.findIndex((event) => event.startsWith("close:")) <
        a.artifactLifecycle.findIndex((event) => event.startsWith("unlink:")),
      scenario.label,
    );
  }
});

test("cleanup never removes a temporary directory outside the exact artifact parent", async () => {
  const a = updateEnvironment();
  const removed = [];
  a.options.makeTemporaryDirectory = () => "/tmp/untrusted-update-directory";
  a.options.inspectArtifactPath = () => ({
    uid: 1000,
    dev: 1,
    ino: 999,
    nlink: 1,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  a.options.removeArtifactDirectory = (target) => removed.push(target);

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(removed, []);
});

test("the artifact parent must be an owned physical directory inside the checkout", async () => {
  const symlink = updateEnvironment({
    artifactParentStat: {
      uid: 1000,
      dev: 1,
      ino: 50,
      nlink: 1,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => true,
    },
  });
  const symlinkResult = await runLearnerLab({
    ...symlink.options,
    step: "plan-update",
    preset: "phase1-5000",
  });
  assert.equal(symlinkResult.status, 1);
  assert.deepEqual(symlink.temporaryDirectories, []);

  const escaped = updateEnvironment();
  escaped.options.resolveArtifactPath = () => "/tmp/redirected-artifacts";
  const escapedResult = await runLearnerLab({
    ...escaped.options,
    step: "plan-update",
    preset: "phase1-5000",
  });
  assert.equal(escapedResult.status, 1);
  assert.deepEqual(escaped.temporaryDirectories, []);
});

test("cleanup failure preserves the primary gate error and reports retention safely", async () => {
  const sentinel = "must-not-replace-primary";
  const a = updateEnvironment({
    updateGateAccepted: false,
    removeArtifactFileError: new Error(sentinel),
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /gate rejected.*unexpected address/i);
  assert.match(a.logs.join("\n"), /cleanup failed.*artifact retained/i);
  assert.doesNotMatch(a.logs.join("\n"), new RegExp(sentinel));
});

test("descriptor close failure retains the private plan and directory", async () => {
  const a = updateEnvironment({ closePlanError: new Error("close failed") });

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(a.removedArtifactFiles, []);
  assert.deepEqual(a.removedArtifactDirectories, []);
  assert.equal(
    [...a.artifactEntries.keys()].filter((entry) => entry.includes("update-phase1-5000-"))
      .length,
    2,
  );
  assert.match(a.logs.join("\n"), /close.*plan|descriptor/i);
});

test("descriptor validation plus close failure also retains the artifact", async () => {
  const a = updateEnvironment({ closePlanError: new Error("close failed") });
  const inspectPlanFile = a.options.inspectPlanFile;
  a.options.inspectPlanFile = (descriptor) => ({
    ...inspectPlanFile(descriptor),
    ino: 999,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(a.removedArtifactFiles, []);
  assert.deepEqual(a.removedArtifactDirectories, []);
  assert.match(a.logs.join("\n"), /descriptor changed identity/i);
  assert.doesNotMatch(a.logs.join("\n"), /could not be closed safely/i);
});

test("a close failure preserves a primary gate error and retains the artifact", async () => {
  const a = updateEnvironment({
    updateGateAccepted: false,
    closePlanError: new Error("close failed"),
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /gate rejected.*unexpected address/i);
  assert.match(a.logs.join("\n"), /close failed.*artifact retained/i);
  assert.doesNotMatch(a.logs.join("\n"), /could not close the validated Terraform plan/i);
  assert.deepEqual(a.removedArtifactFiles, []);
  assert.deepEqual(a.removedArtifactDirectories, []);
});

test("creation failure never removes a substituted directory without its original identity", async () => {
  const a = updateEnvironment();
  const inspect = a.options.inspectArtifactPath;
  let directoryInspections = 0;
  a.options.inspectArtifactPath = (target) => {
    if (String(target).includes("update-phase1-5000-") && !String(target).endsWith(".tfplan")) {
      directoryInspections += 1;
      if (directoryInspections === 1) {
        const metadata = inspect(target);
        return {
          ...metadata,
          ino: metadata.ino + 1000,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        };
      }
    }
    return inspect(target);
  };

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(a.removedArtifactDirectories, []);
  assert.equal(directoryInspections, 1);
});

test("cleanup refuses replaced plan or directory identities", async () => {
  for (const targetKind of ["directory", "plan"]) {
    const a = updateEnvironment();
    const inspect = a.options.inspectArtifactPath;
    let targetInspections = 0;
    a.options.inspectArtifactPath = (target) => {
      const isPlan = String(target).endsWith(".tfplan");
      const isDirectory =
        String(target).includes("update-phase1-5000-") && !isPlan;
      if (
        (targetKind === "plan" && isPlan) ||
        (targetKind === "directory" && isDirectory)
      ) {
        targetInspections += 1;
        const metadata = inspect(target);
        if (targetInspections > 1) return { ...metadata, ino: metadata.ino + 1000 };
        return metadata;
      }
      return inspect(target);
    };

    const result = await runLearnerLab({
      ...a.options,
      step: "plan-update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 1, targetKind);
    assert.deepEqual(a.removedArtifactFiles, [], targetKind);
    assert.deepEqual(a.removedArtifactDirectories, [], targetKind);
  }
});

test("cleanup refuses a hard link added at the last inspection before unlink", async () => {
  const a = updateEnvironment();
  const inspect = a.options.inspectArtifactPath;
  let cleanupPlanInspections = 0;
  a.options.inspectArtifactPath = (target) => {
    const metadata = inspect(target);
    if (
      String(target).endsWith(".tfplan") &&
      a.artifactLifecycle.some((event) => event.startsWith("close:"))
    ) {
      cleanupPlanInspections += 1;
      if (cleanupPlanInspections === 2) return { ...metadata, nlink: 2 };
    }
    return metadata;
  };

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(cleanupPlanInspections, 2);
  assert.equal(result.status, 1);
  assert.deepEqual(a.removedArtifactFiles, []);
  assert.deepEqual(a.removedArtifactDirectories, []);
});

test("cleanup does not rmdir when the last directory identity check is missing or replaced", async () => {
  for (const race of ["missing", "replaced"]) {
    const a = updateEnvironment();
    const inspect = a.options.inspectArtifactPath;
    let finalDirectoryInspectionReached = false;
    a.options.inspectArtifactPath = (target) => {
      const isUpdateDirectory =
        String(target).includes("update-phase1-5000-") &&
        !String(target).endsWith(".tfplan");
      if (
        isUpdateDirectory &&
        a.artifactLifecycle.some((event) => event.startsWith("unlink:"))
      ) {
        finalDirectoryInspectionReached = true;
        if (race === "missing") {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        }
        const metadata = inspect(target);
        return { ...metadata, ino: metadata.ino + 1000 };
      }
      return inspect(target);
    };

    const result = await runLearnerLab({
      ...a.options,
      step: "plan-update",
      preset: "phase1-5000",
    });

    assert.equal(finalDirectoryInspectionReached, true, race);
    assert.equal(result.status, 1, race);
    assert.deepEqual(a.removedArtifactDirectories, [], race);
  }
});

test("update rejects unknown presets and extra arguments before any tool call", async () => {
  for (const options of [
    { preset: "custom", extraArguments: [] },
    { preset: "phase1-5000", extraArguments: ["-var=quantidade_tasks=4"] },
  ]) {
    const a = updateEnvironment();
    const result = await runLearnerLab({ ...a.options, step: "update", ...options });

    assert.notEqual(result.status, 0);
    assert.deepEqual(a.calls, []);
  }
});

test("protected update commands require the primary checkout and configured region", async () => {
  const invalidEnvironments = [
    { AWS_PROFILE: "default", AWS_DEFAULT_PROFILE: "other-profile", AWS_REGION: "us-east-1" },
    { AWS_PROFILE: "default", AWS_REGION: "sa-east-1" },
    { AWS_PROFILE: "default", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "secret" },
    { AWS_PROFILE: "default", AWS_REGION: "us-east-1", AWS_SECRET_ACCESS_KEY: "secret" },
    { AWS_PROFILE: "default", AWS_REGION: "us-east-1", AWS_SESSION_TOKEN: "secret" },
    { AWS_PROFILE: "default", AWS_REGION: "us-east-1", AWS_CONFIG_FILE: "/tmp/config" },
    {
      AWS_PROFILE: "default",
      AWS_REGION: "us-east-1",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/credentials",
    },
  ];

  for (const environment of invalidEnvironments) {
    const a = updateEnvironment({ environment });
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });
    assert.equal(result.status, 1, JSON.stringify(environment));
    assert.deepEqual(a.calls, [], JSON.stringify(environment));
    assert.doesNotMatch(a.logs.join("\n"), /secret/);
  }

  const worktree = updateEnvironment({ root: "/repo/worktree" });
  const result = await runLearnerLab({
    ...worktree.options,
    step: "check",
    realpath: (target) => target,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(worktree.calls, []);
  assert.match(worktree.logs.join("\n"), /primary Git checkout/i);
});

test("protected commands accept the primary checkout at a portable path", async () => {
  const a = testEnvironment({ root: "/workspace/view-show", gitCheckout: "main" });

  const result = await runLearnerLab({
    ...a.options,
    step: "check",
    realpath: (target) => target,
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
});

test("protected commands accept an omitted AWS_REGION and pin the canonical region internally", async () => {
  const a = testEnvironment({ environment: { AWS_PROFILE: "default" } });

  const result = await runLearnerLab({ ...a.options, step: "check" });

  assert.equal(result.status, 0, a.logs.join("\n"));
  for (const call of a.calls.filter((call) => call.command === "aws" && call.args[0] !== "--version")) {
    assert.equal(call.args.includes("--region"), true);
    assert.equal(call.args[call.args.indexOf("--region") + 1], "us-east-1");
  }
});

test("seed fails closed on an unsafe checkout or AWS binding before any tool call", async () => {
  const cases = [
    { root: "/repo/worktree" },
    { environment: { AWS_PROFILE: "default", AWS_REGION: "sa-east-1" } },
    {
      environment: {
        AWS_PROFILE: "default",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "must-not-be-printed",
      },
    },
  ];

  for (const configuration of cases) {
    const a = testEnvironment(configuration);
    const result = await runLearnerLab({ ...a.options, step: "seed" });

    assert.equal(result.status, 1, JSON.stringify(configuration));
    assert.deepEqual(a.calls, [], JSON.stringify(configuration));
    assert.doesNotMatch(a.logs.join("\n"), /must-not-be-printed/);
  }
});

test("all fails closed on an unsafe checkout or AWS binding before any tool call", async () => {
  for (const configuration of [
    { root: "/repo/worktree" },
    { environment: { AWS_PROFILE: "default", AWS_REGION: "sa-east-1" } },
  ]) {
    const a = testEnvironment(configuration);
    const result = await runLearnerLab({ ...a.options, step: "all" });

    assert.equal(result.status, 1, JSON.stringify(configuration));
    assert.deepEqual(a.calls, [], JSON.stringify(configuration));
  }
});

test("local state must be a regular owned non-symlink with valid lineage and serial before init", async () => {
  const invalidCases = [
    {
      label: "missing",
      mutate: (options) => {
        options.lstat = () => {
          throw new Error("ENOENT");
        };
      },
    },
    {
      label: "symlink",
      mutate: (options) => {
        options.lstat = () => ({
          uid: 1000,
          isFile: () => true,
          isSymbolicLink: () => true,
        });
      },
    },
    {
      label: "wrong owner",
      mutate: (options) => {
        options.lstat = () => ({
          uid: 2000,
          isFile: () => true,
          isSymbolicLink: () => false,
        });
      },
    },
    {
      label: "empty lineage",
      mutate: (options) => {
        options.readFile = () => JSON.stringify({ lineage: "", serial: 7 });
      },
    },
    {
      label: "non-positive serial",
      mutate: (options) => {
        options.readFile = () => JSON.stringify({ lineage: "lineage-1", serial: 0 });
      },
    },
  ];

  for (const { label, mutate } of invalidCases) {
    const a = updateEnvironment();
    mutate(a.options);
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });
    assert.equal(result.status, 1, label);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("init")),
      false,
      label,
    );
  }
});

test("remote state lineage and serial plus runbook owner must match before planning", async () => {
  for (const configuration of [
    { remoteStateSerial: 6 },
    { stateLineage: "lineage-1", stateFileText: JSON.stringify({ lineage: "other", serial: 7 }) },
    { runbookOwner: "999999999999" },
  ]) {
    const a = updateEnvironment(configuration);
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });
    assert.equal(result.status, 1, JSON.stringify(configuration));
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
      false,
    );
  }
});

test("an active import aborts before planning and logs only its public import id", async () => {
  const importId = "imp_01K59Z5XE00000000000000000";
  const a = updateEnvironment({ activeImportId: importId });
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  const getItem = a.calls.find(
    (call) => call.command === "aws" && call.args.slice(0, 2).join(" ") === "dynamodb get-item",
  );
  assert.ok(getItem);
  assert.ok(getItem.args.includes("--consistent-read"));
  assert.deepEqual(JSON.parse(getItem.args[getItem.args.indexOf("--key") + 1]), {
    pk: { S: "CONTROL#IMPORT" },
    sk: { S: "ACTIVE" },
  });
  assert.match(a.logs.join("\n"), new RegExp(importId));
  assert.doesNotMatch(a.logs.join("\n"), /privateSnapshotKey|must-not-be-printed/);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")),
    false,
  );
});

test("update rechecks the active-import control record immediately before apply", async () => {
  const a = updateEnvironment({ preset: "phase2-10000" });
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase2-10000",
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const reads = a.calls.filter(
    (call) =>
      call.command === "aws" &&
      call.args.slice(0, 2).join(" ") === "dynamodb get-item" &&
      call.args.join(" ").includes("CONTROL#IMPORT"),
  );
  const applyIndex = a.calls.findIndex(
    (call) => call.command === "terraform" && call.args.includes("apply"),
  );
  assert.equal(reads.length, 2);
  assert.ok(a.calls.indexOf(reads.at(-1)) < applyIndex);
});

test("an import that starts after confirmation prevents update apply", async () => {
  const importId = "imp_01K59Z5XE00000000000000001";
  const a = updateEnvironment({
    preset: "phase2-10000",
    activeImportIds: [null, importId],
  });
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase2-10000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), new RegExp(importId));
  assert.doesNotMatch(a.logs.join("\n"), /privateSnapshotKey|must-not-be-printed/);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("an empty successful get-item response means no active import", async () => {
  const a = updateEnvironment({ emptyActiveImportOutput: true });
  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.ok(
    a.calls.some(
      (call) => call.command === "terraform" && call.args.includes("plan"),
    ),
  );
});

test("update backs up state privately before apply and revalidates state and outputs afterward", async () => {
  const a = updateEnvironment();
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(a.copies.length, 0);
  assert.equal(a.backupWrites.length, 1);
  const backupWrite = a.backupWrites[0];
  assert.equal(
    backupWrite.target,
    path.join(
      ORIGINAL_ROOT,
      "apps",
      "fullstack",
      ".terraform-artifacts",
      "state-backups",
      "terraform.tfstate.2026-09-21T12-34-56-789Z",
    ),
  );
  assert.doesNotMatch(backupWrite.target, /[/\\]\.artifacts[/\\]/);
  const sourceOpen = a.backupOpens.find(({ logicalTarget }) =>
    logicalTarget.endsWith(`${path.sep}terraform.tfstate`),
  );
  const directoryOpen = a.backupOpens.find(
    ({ logicalTarget }) => logicalTarget.endsWith(`${path.sep}state-backups`),
  );
  const destinationOpen = a.backupOpens.find(({ logicalTarget }) =>
    logicalTarget.includes("terraform.tfstate.2026-09-21T12-34-56-789Z"),
  );
  assert.ok(sourceOpen.flags & fsConstants.O_NOFOLLOW);
  assert.ok(directoryOpen.flags & fsConstants.O_NOFOLLOW);
  assert.ok(directoryOpen.flags & fsConstants.O_DIRECTORY);
  assert.match(destinationOpen.target, /^\/proc\/self\/fd\/\d+\/terraform\.tfstate\./);
  assert.ok(destinationOpen.flags & fsConstants.O_EXCL);
  assert.ok(destinationOpen.flags & fsConstants.O_NOFOLLOW);
  assert.equal(destinationOpen.mode, 0o600);
  assert.deepEqual(a.closedBackupDescriptors.sort(), a.backupDescriptors.sort());
  const applyIndex = a.calls.findIndex(
    (call) => call.command === "terraform" && call.args.includes("apply"),
  );
  const postPullIndex = a.calls.findLastIndex(
    (call) => call.command === "terraform" && call.args.includes("pull"),
  );
  const postOutputIndex = a.calls.findLastIndex(
    (call) => call.command === "terraform" && call.args.includes("output"),
  );
  const postShowIndex = a.calls.findLastIndex(
    (call) =>
      call.command === "terraform" &&
      call.args.includes("show") &&
      !call.args.some((arg) => String(arg).endsWith(".tfplan")),
  );
  assert.ok(applyIndex >= 0);
  assert.ok(postPullIndex > applyIndex);
  assert.ok(postOutputIndex > applyIndex);
  assert.ok(postShowIndex > applyIndex);
});

test("update creates its protected state backup through a Linux directory descriptor", async () => {
  const a = updateEnvironment({ platform: "linux" });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const destinationOpen = a.backupOpens.find(
    ({ flags }) => (flags & fsConstants.O_CREAT) !== 0,
  );
  assert.match(destinationOpen.target, /^\/proc\/self\/fd\/\d+\/terraform\.tfstate\./);
  assert.ok(destinationOpen.flags & fsConstants.O_EXCL);
  assert.equal(a.backupWrites.length, 1);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    true,
  );
});

test("update fails closed when the macOS protected state backup helper fails", async () => {
  const a = updateEnvironment({ platform: "darwin" });
  const execute = a.options.execute;
  a.options.execute = (command, args, options) =>
    command === "python3"
      ? { status: 1, stdout: "", stderr: "backup helper failed" }
      : execute(command, args, options);

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1, a.logs.join("\n"));
  assert.equal(a.backupWrites.length, 0);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
  assert.match(a.logs.join("\n"), /secure Terraform state backup could not be created/i);
});

test("update rejects untrusted or replaced backup paths before copy and apply", async () => {
  const backupDirectory = path.join(
    ORIGINAL_ROOT,
    "apps",
    "fullstack",
    ".terraform-artifacts",
    "state-backups",
  );
  const backupPath = path.join(
    backupDirectory,
    "terraform.tfstate.2026-09-21T12-34-56-789Z",
  );
  const cases = [
    {
      label: "parent symlink",
      mutate: (_a, metadata) => ({
        ...metadata,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      }),
    },
    {
      label: "parent wrong owner",
      mutate: (_a, metadata) => ({ ...metadata, uid: 2000 }),
    },
    {
      label: "parent replaced",
      mutate: (_a, metadata) => ({ ...metadata, ino: metadata.ino + 1 }),
    },
    {
      label: "destination exists",
      destination: {
        uid: 1000,
        dev: 1,
        ino: 300,
        nlink: 1,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    },
    {
      label: "destination symlink",
      destination: {
        uid: 1000,
        dev: 1,
        ino: 301,
        nlink: 1,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
    },
  ];

  for (const scenario of cases) {
    const a = updateEnvironment();
    if (scenario.destination) a.artifactEntries.set(backupPath, scenario.destination);
    if (scenario.mutate) {
      const inspect = a.options.inspectArtifactPath;
      let inspections = 0;
      a.options.inspectArtifactPath = (target) => {
        const metadata = inspect(target);
        if (target !== backupDirectory) return metadata;
        inspections += 1;
        if (scenario.label === "parent replaced" && inspections === 1) return metadata;
        return scenario.mutate(a, metadata);
      };
    }

    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 1, scenario.label);
    assert.deepEqual(a.copies, [], scenario.label);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
      false,
      scenario.label,
    );
  }
});

test("update rejects descriptor-time source or directory substitution without writing or applying", async () => {
  const statePath = path.join(ORIGINAL_ROOT, "apps", "fullstack", "terraform.tfstate");
  const backupDirectory = path.join(
    ORIGINAL_ROOT,
    "apps",
    "fullstack",
    ".terraform-artifacts",
    "state-backups",
  );
  for (const race of ["source replaced", "directory became symlink"]) {
    const a = updateEnvironment();
    if (race === "source replaced") {
      const inspect = a.options.inspectBackupFile;
      a.options.inspectBackupFile = (descriptor) => {
        const metadata = inspect(descriptor);
        return a.backupDescriptorTargets.get(descriptor) === statePath
          ? { ...metadata, ino: metadata.ino + 1 }
          : metadata;
      };
    } else {
      const open = a.options.openBackupPath;
      a.options.openBackupPath = (target, flags, mode) => {
        if (target === backupDirectory) {
          const error = new Error("ELOOP");
          error.code = "ELOOP";
          throw error;
        }
        return open(target, flags, mode);
      };
    }

    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 1, race);
    assert.deepEqual(a.backupWrites, [], race);
    assert.deepEqual(a.copies, [], race);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
      false,
      race,
    );
  }
});

test("post-apply state regression fails closed even though Terraform already returned success", async () => {
  const a = updateEnvironment({ postApplyStateSerial: 6 });
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /serial|state/i);
});

test("post-apply verification rejects mutable images, unversioned tasks, stale schedules, and wrong preset flags", async () => {
  const mutations = [
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].image = "mysql:8.4";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_sync",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "68719476736";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) =>
          resource.address === "aws_ecs_task_definition.ingestion_incremental_export",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "17179869184";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) =>
          resource.address === "aws_ecs_task_definition.ingestion_incremental_ingest",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "8589934592";
      task.values.container_definitions = JSON.stringify(containers);
    },
    ...[
      "aws_ecs_task_definition.ingestion_backfill",
      "aws_ecs_task_definition.ingestion_import",
      "aws_ecs_task_definition.ingestion_sync",
      "aws_ecs_task_definition.ingestion_incremental_export",
      "aws_ecs_task_definition.ingestion_incremental_ingest",
    ].map(
      (address) => (state) => {
        const task = state.values.root_module.resources.find(
          (resource) => resource.address === address,
        );
        task.values.ephemeral_storage[0].size_in_gib = 199;
      },
    ),
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.api",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-api:latest";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers.find((container) => container.name === "mysql-snapshot").image =
        "mysql@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      task.values.arn =
        "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-import";
    },
    (state) => {
      const schedule = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_scheduler_schedule.ingestion_sync",
      );
      schedule.values.target[0].ecs_parameters[0].task_definition_arn =
        "arn:aws:ecs:us-east-1:111122223333:task-definition/stale:1";
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "MYSQL_SNAPSHOT_PREPARE_ENABLED",
      ).value = "false";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.api",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "IMPORT_CANONICAL_FIRST_ENABLED",
      ).value = "true";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "IMPORT_HOT_MATERIALIZATION_ENABLED",
      ).value = "true";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_backfill",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "17179869184";
      task.values.container_definitions = JSON.stringify(containers);
    },
    (state) => {
      const task = state.values.root_module.resources.find(
        (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
      );
      const containers = JSON.parse(task.values.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "17179869184";
      task.values.container_definitions = JSON.stringify(containers);
    },
  ];

  for (const mutate of mutations) {
    const state = structuredClone(postApplyState("phase1-5000"));
    mutate(state);
    const a = updateEnvironment({ postApplyTerraformState: state });
    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });
    assert.equal(result.status, 1);
  }
});

test("post-apply verification rejects a well-formed worker digest that differs from the validated plan", async () => {
  const state = postApplyState("phase1-5000");
  const task = state.values.root_module.resources.find(
    (resource) => resource.address === "aws_ecs_task_definition.ingestion_sync",
  );
  const containers = JSON.parse(task.values.container_definitions);
  containers[0].image =
    "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  task.values.container_definitions = JSON.stringify(containers);
  const a = updateEnvironment({ postApplyTerraformState: state });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /unknown|container|image|reference|digest|diverged/i);
});

test("update rejects a validated plan that changes the fixed MySQL snapshot digest", async () => {
  const planState = postApplyState("phase1-5000");
  const task = planState.values.root_module.resources.find(
    (resource) => resource.address === "aws_ecs_task_definition.ingestion_import",
  );
  const containers = JSON.parse(task.values.container_definitions);
  containers.find((container) => container.name === "mysql-snapshot").image =
    "mysql@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  task.values.container_definitions = JSON.stringify(containers);
  const a = updateEnvironment({ updatePlanTerraformState: planState });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /mysql|digest|image/i);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("Terraform-native unknown planned container JSON is rejected before apply", async () => {
  const planState = postApplyState("phase1-5000");
  for (const task of planState.values.root_module.resources.filter(
    (resource) => resource.type === "aws_ecs_task_definition",
  )) {
    task.values.container_definitions = null;
  }
  const a = updateEnvironment({
    updatePlanTerraformState: planState,
    planIngestionImage: null,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1, a.logs.join("\n"));
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("a stable ECR lookup remains verifiable from planned values", async () => {
  const a = updateEnvironment();
  const originalExecute = a.options.execute;
  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
    execute: (command, args, options) => {
      const response = originalExecute(command, args, options);
      if (
        command === "terraform" &&
        args.includes("show") &&
        args.includes("-json") &&
        args.includes("/proc/self/fd/3") &&
        response.status === 0
      ) {
        const plan = JSON.parse(response.stdout);
        const plannedResources = plan.planned_values.root_module.resources;
        const stableEcrImage = plannedResources.find(
          (resource) => resource.address === "data.aws_ecr_image.ingestion[0]",
        );
        plan.planned_values.root_module.resources = plannedResources.filter(
          (resource) => resource.address !== "data.aws_ecr_image.ingestion[0]",
        );
        plan.prior_state.values = {
          root_module: { resources: [stableEcrImage] },
        };
        plan.resource_changes = plan.resource_changes.filter(
          (change) =>
            change.address !== "data.aws_ecr_image.ingestion[0]" &&
            change.address !== "terraform_data.ingestion_image[0]",
        );
        return { ...response, stdout: JSON.stringify(plan) };
      }
      return response;
    },
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
});

test("unknown planned images reject a uniform digest that diverges from ECR resolution", async () => {
  const differentImage =
    "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const planState = postApplyState("phase1-5000");
  for (const task of planState.values.root_module.resources.filter(
    (resource) => resource.type === "aws_ecs_task_definition",
  )) {
    task.values.container_definitions = null;
  }
  const appliedState = postApplyState("phase1-5000");
  for (const task of appliedState.values.root_module.resources.filter(
    (resource) =>
      resource.type === "aws_ecs_task_definition" &&
      resource.address !== "aws_ecs_task_definition.api",
  )) {
    const containers = JSON.parse(task.values.container_definitions);
    for (const container of containers) {
      if (container.name !== "mysql-snapshot") container.image = differentImage;
    }
    task.values.container_definitions = JSON.stringify(containers);
  }
  const a = updateEnvironment({
    updatePlanTerraformState: planState,
    postApplyTerraformState: appliedState,
    planIngestionImage: null,
    runbookImage: differentImage,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /unknown|container|image|reference|digest|diverged/i);
});

test("post-apply ECR resolution must keep the repository and content tag from the plan", async () => {
  const state = postApplyState("phase1-5000");
  state.values.root_module.resources.find(
    (resource) => resource.address === "data.aws_ecr_image.ingestion[0]",
  ).values.image_tag = "bbbbbbbbbbbb";
  const a = updateEnvironment({ postApplyTerraformState: state });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /ecr|image|repository|tag|diverged/i);
});

test("a well-formed planned ECR tag must equal the Terraform image source hash prefix", async () => {
  const planState = postApplyState("phase1-5000");
  const appliedState = postApplyState("phase1-5000");
  for (const state of [planState, appliedState]) {
    state.values.root_module.resources.find(
      (resource) => resource.address === "data.aws_ecr_image.ingestion[0]",
    ).values.image_tag = "bbbbbbbbbbbb";
  }
  const a = updateEnvironment({
    updatePlanTerraformState: planState,
    postApplyTerraformState: appliedState,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.equal(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
    false,
  );
});

test("a uniform worker reference from another ECR account is rejected", async () => {
  const wrongImage =
    "999900001111.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const planState = postApplyState("phase1-5000");
  for (const task of planState.values.root_module.resources.filter(
    (resource) => resource.type === "aws_ecs_task_definition",
  )) {
    task.values.container_definitions = null;
  }
  const appliedState = postApplyState("phase1-5000");
  appliedState.values.root_module.resources.find(
    (resource) => resource.address === "aws_ecr_repository.ingestion",
  ).values.repository_url =
    "999900001111.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion";
  for (const task of appliedState.values.root_module.resources.filter(
    (resource) =>
      resource.type === "aws_ecs_task_definition" &&
      resource.address !== "aws_ecs_task_definition.api",
  )) {
    const containers = JSON.parse(task.values.container_definitions);
    for (const container of containers) {
      if (container.name !== "mysql-snapshot") container.image = wrongImage;
    }
    task.values.container_definitions = JSON.stringify(containers);
  }
  const a = updateEnvironment({
    updatePlanTerraformState: planState,
    postApplyTerraformState: appliedState,
    planIngestionImage: null,
    runbookImage: wrongImage,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 1);
  assert.match(a.logs.join("\n"), /account|ecr|image|repository|diverged/i);
});

test("unknown image markers must use the exact boolean leaves from Terraform", async () => {
  const planState = postApplyState("phase1-5000");
  for (const task of planState.values.root_module.resources.filter(
    (resource) => resource.type === "aws_ecs_task_definition",
  )) {
    task.values.container_definitions = null;
  }
  for (const configuration of [
    { planEcrUnknownMarker: { nested: true } },
    { planOutputUnknownMarker: { nested: true } },
    { planContainerUnknownMarker: { nested: true } },
  ]) {
    const a = updateEnvironment({
      updatePlanTerraformState: structuredClone(planState),
      planIngestionImage: null,
      ...configuration,
    });

    const result = await runLearnerLab({
      ...a.options,
      step: "update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, 1, JSON.stringify(configuration));
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
      false,
      JSON.stringify(configuration),
    );
  }
});

test("a null planned ingestion output is unknown only with its exact boolean marker", async () => {
  const planState = postApplyState("phase1-5000");

  for (const { label, marker, present = true, expectedStatus } of [
    { label: "exact boolean marker", marker: true, expectedStatus: 0 },
    { label: "missing marker", marker: true, present: false, expectedStatus: 1 },
    { label: "false marker", marker: false, expectedStatus: 1 },
    { label: "string marker", marker: "true", expectedStatus: 1 },
  ]) {
    const a = updateEnvironment({
      updatePlanTerraformState: structuredClone(planState),
      planIngestionImage: null,
      planOutputUnknownMarker: marker,
      planOutputUnknownMarkerPresent: present,
      planOutputUsesNull: true,
    });

    const result = await runLearnerLab({
      ...a.options,
      step: "plan-update",
      preset: "phase1-5000",
    });

    assert.equal(result.status, expectedStatus, label);
  }
});

test("an omitted planned ECR digest remains verifiable with its exact unknown marker", async () => {
  const a = updateEnvironment({
    planIngestionImage: null,
    planEcrOmitsDigest: true,
  });

  const result = await runLearnerLab({
    ...a.options,
    step: "plan-update",
    preset: "phase1-5000",
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
});

const CANARY_IMPORT_ID = "imp_01K5Z9P7Z7A1B2C3D4E5F6G7H8";
const CANARY_RUN_ID = "run_import_01K5Z9P7Z7A1B2C3D4E5F6G7H8";
const CANARY_TASK_ARN =
  "arn:aws:ecs:us-east-1:111122223333:task/view-show-cluster/0123456789abcdef0123456789abcdef";
const CANARY_CLUSTER_ARN =
  "arn:aws:ecs:us-east-1:111122223333:cluster/view-show-cluster";
const CANARY_TASK_DEFINITION =
  "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-ingestion-import:8";
const CANARY_PANEL_URL = "https://main.example.amplifyapp.com";
const CANARY_BUCKET = "view-show-ingestion-111122223333-us-east-1";
const CANARY_PART_SIZE = 16 * 1024 * 1024;

function canarySnapshot(state, stage = "PROJECTING", overrides = {}) {
  return {
    importId: CANARY_IMPORT_ID,
    fileName: "argus_dump.sql.gz",
    sizeBytes: CANARY_PART_SIZE * 3 + 7,
    snapshotExtractedOn: "2026-09-01",
    state,
    candidateVersion: state === "READY" ? `dsv_${"a".repeat(64)}` : null,
    progress:
      state === "PREPARING" || state === "UPLOADING"
        ? {
            kind: "bytes",
            completedBytes: 0,
            totalBytes: CANARY_PART_SIZE * 3 + 7,
          }
        : {
            kind: "stage",
            stage,
            recordsRead: 23,
            recordsWritten: 23,
            recordsRejected: 0,
          },
    error: null,
    ...overrides,
  };
}

function canarySignedUploadUrl(
  partNumber,
  {
    bucket = CANARY_BUCKET,
    region = "us-east-1",
    host = `${bucket}.s3.${region}.amazonaws.com`,
    pathName = `/imports/${CANARY_IMPORT_ID}/part-${partNumber}`,
  } = {},
) {
  const credential = encodeURIComponent(`AKIAEXAMPLE/20260922/${region}/s3/aws4_request`);
  return `https://${host}${pathName}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${credential}&X-Amz-Signature=${"a".repeat(64)}`;
}

function fakeResponse(status, payload, responseHeaders = {}) {
  const headers = new Map(
    Object.entries(responseHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function importCanaryEnvironment({
  root = ROOT,
  stopAtStage = null,
  startSnapshot = canarySnapshot("UPLOADING", "STARTING"),
  statuses = [canarySnapshot("READY", "SUCCEEDED")],
  signedUrlForPart = (partNumber) => canarySignedUploadUrl(partNumber),
  redirectAt = null,
  describedTaskArn = CANARY_TASK_ARN,
  persistedImportId = CANARY_IMPORT_ID,
  includeImportIdentityOverride = true,
  importIdentityOverrideCount = includeImportIdentityOverride ? 1 : 0,
  pipelineOverrideCount = 1,
  pipelineOverride = "canonical-v2",
  taskClusterArn = CANARY_CLUSTER_ARN,
  taskDefinitionArn = CANARY_TASK_DEFINITION,
  taskContainerName = "ingestion",
  taskCommand = ["import-dump", "--import-id", CANARY_IMPORT_ID],
  importStage = "PROJECTING",
  runStage = "PROJECTING",
  afterConfirmationStage = null,
  confirmationAdvanceSeconds = 0,
  postConfirmationRevalidationAdvanceSeconds = 0,
  persistFailed = true,
  releaseLock = true,
  activeDataset = `dsv_${"0".repeat(64)}`,
  activeAfterStop = `dsv_${"0".repeat(64)}`,
} = {}) {
  const base = testEnvironment({ root });
  const externalCalls = [];
  const requests = [];
  const evidenceWrites = [];
  const confirmations = [];
  const closedSnapshots = [];
  const uploadedParts = [];
  const checksums = [1, 2, 3, 4].map((value) =>
    Buffer.alloc(32, value).toString("base64"),
  );
  const parts = [
    {
      partNumber: 1,
      offset: 0,
      sizeBytes: CANARY_PART_SIZE,
      checksumSha256: checksums[0],
    },
    {
      partNumber: 2,
      offset: CANARY_PART_SIZE,
      sizeBytes: CANARY_PART_SIZE,
      checksumSha256: checksums[1],
    },
    {
      partNumber: 3,
      offset: CANARY_PART_SIZE * 2,
      sizeBytes: CANARY_PART_SIZE,
      checksumSha256: checksums[2],
    },
    {
      partNumber: 4,
      offset: CANARY_PART_SIZE * 3,
      sizeBytes: 7,
      checksumSha256: checksums[3],
    },
  ];
  let statusIndex = 0;
  let stopCalls = 0;
  let activeUploads = 0;
  let maximumActiveUploads = 0;
  let clock = 0;
  const runbook = {
    storage: { bucket: CANARY_BUCKET },
    image: { immutable_uri: INGESTION_IMAGE },
    imports: {
      expected_bucket_owner: "111122223333",
      cors_origin: CANARY_PANEL_URL,
      cluster_arn: CANARY_CLUSTER_ARN,
      task_definition_arn: CANARY_TASK_DEFINITION,
      container_name: "ingestion",
    },
    runtime: { cluster_arn: CANARY_CLUSTER_ARN },
    data: {
      operational_table: "view-show-operacional",
      snapshot_secret_arn:
        "arn:aws:secretsmanager:us-east-1:111122223333:secret:view-show-ingestion/snapshot-mysql",
    },
  };
  const dynamoItem = (args) => {
    const serialized = args.join(" ");
    if (serialized.includes("CONTROL#DATASET")) {
      return {
        Item: {
          pk: { S: "CONTROL#DATASET" },
          sk: { S: "ACTIVE" },
          activeDatasetVersion: {
            S: stopCalls === 0 ? activeDataset : activeAfterStop,
          },
        },
      };
    }
    if (serialized.includes("CONTROL#IMPORT")) {
      return stopCalls > 0 && releaseLock
        ? {}
        : {
            Item: {
              pk: { S: "CONTROL#IMPORT" },
              sk: { S: "ACTIVE" },
              importId: { S: CANARY_IMPORT_ID },
            },
          };
    }
    if (serialized.includes("INGESTION#RUN#")) {
      const currentRunStage =
        confirmations.length > 0 && afterConfirmationStage !== null ? afterConfirmationStage : runStage;
      return {
        Item: {
          pk: { S: `INGESTION#RUN#${CANARY_RUN_ID}` },
          sk: { S: "META" },
          runId: { S: CANARY_RUN_ID },
          stage: { S: currentRunStage },
        },
      };
    }
    if (serialized.includes("IMPORT#")) {
      const failed = stopCalls > 0 && persistFailed;
      const currentImportStage =
        confirmations.length > 0 && afterConfirmationStage !== null ? afterConfirmationStage : importStage;
      return {
        Item: {
          pk: { S: "IMPORTS" },
          sk: { S: `IMPORT#${CANARY_IMPORT_ID}` },
          importId: { S: persistedImportId },
          state: { S: failed ? "FAILED" : "PROCESSING" },
          taskArn: { S: CANARY_TASK_ARN },
          pipelineVersion: { S: "canonical-v2" },
          progressRunStage: { S: currentImportStage },
          candidateVersion: { NULL: true },
          error: {
            M: {
              code: { S: "ARCHIVE_PUBLICATION_FAILED" },
              retryable: { BOOL: failed },
            },
          },
        },
      };
    }
    throw new Error(`unexpected DynamoDB key: ${serialized}`);
  };
  const execute = (command, args, options = {}) => {
    externalCalls.push({ command, args, options });
    if (command === "terraform" && args.includes("output")) {
      if (args.at(-1) === "painel_url") {
        return {
          status: 0,
          stdout: JSON.stringify(CANARY_PANEL_URL),
          stderr: "",
        };
      }
      if (args.at(-1) === "ingestion_runbook") {
        return { status: 0, stdout: JSON.stringify(runbook), stderr: "" };
      }
    }
    if (command === "aws" && args[0] === "dynamodb" && args[1] === "get-item") {
      return {
        status: 0,
        stdout: JSON.stringify(dynamoItem(args)),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-tasks") {
      if (confirmations.length > 0 && stopCalls === 0) {
        clock += postConfirmationRevalidationAdvanceSeconds;
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          failures: [],
          tasks: [
            {
              taskArn: describedTaskArn,
              clusterArn: taskClusterArn,
              taskDefinitionArn,
              lastStatus: stopCalls > 0 ? "STOPPED" : "RUNNING",
              overrides: {
                containerOverrides: [
                  {
                    name: taskContainerName,
                    command: taskCommand,
                    environment: [
                      ...Array.from({ length: importIdentityOverrideCount }, () => ({
                        name: "IMPORT_ID",
                        value: CANARY_IMPORT_ID,
                      })),
                      ...Array.from({ length: pipelineOverrideCount }, () => ({
                        name: "IMPORT_PIPELINE_VERSION",
                        value: pipelineOverride,
                      })),
                    ],
                  },
                ],
              },
              containers: [
                {
                  name: "ingestion",
                  lastStatus: stopCalls > 0 ? "STOPPED" : "RUNNING",
                  ...(stopCalls > 0 ? { exitCode: 137 } : {}),
                },
              ],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "aws" && args[0] === "ecs" && args[1] === "stop-task") {
      stopCalls += 1;
      return {
        status: 0,
        stdout: JSON.stringify({ task: { taskArn: CANARY_TASK_ARN } }),
        stderr: "",
      };
    }
    return base.options.execute(command, args, options);
  };
  const httpRequest = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (options.method === "PUT") {
      activeUploads += 1;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      await new Promise((resolve) => setImmediate(resolve));
      activeUploads -= 1;
      const partNumber = Number(/part-(\d+)$/.exec(parsed.pathname)?.[1]);
      uploadedParts.push(partNumber);
      return fakeResponse(200, {}, { etag: `etag-${partNumber}` });
    }
    assert.equal(parsed.origin, CANARY_PANEL_URL);
    const redirected = (operation) => {
      if (redirectAt?.operation !== operation) return null;
      return fakeResponse(
        redirectAt.status,
        {},
        {
          location: "https://attacker.example/steal",
        },
      );
    };
    if (parsed.pathname === "/auth/login") {
      return fakeResponse(200, { data: { token: "must-not-persist" } }, {
        "set-cookie": "session=private-cookie; Path=/; HttpOnly; Secure",
      });
    }
    if (parsed.pathname === "/api/v1/imports" && options.method === "POST") {
      return redirected("start") ?? fakeResponse(201, { data: startSnapshot });
    }
    if (parsed.pathname.endsWith("/parts") && options.method === "GET") {
      return (
        redirected("list") ??
        fakeResponse(200, {
          data: {
            parts: [
              {
                partNumber: 1,
                etag: "etag-1",
                checksumSha256: checksums[0],
                sizeBytes: CANARY_PART_SIZE,
              },
            ],
          },
        })
      );
    }
    if (parsed.pathname.endsWith("/parts") && options.method === "POST") {
      const redirect = redirected("sign");
      if (redirect !== null) return redirect;
      const requested = JSON.parse(options.body).parts;
      return fakeResponse(200, {
        data: {
          parts: requested.map((part) => ({
            partNumber: part.partNumber,
            url: signedUrlForPart(part.partNumber),
            headers: { "x-amz-checksum-sha256": part.checksumSha256 },
            expiresAt: "2026-09-21T13:00:00.000Z",
          })),
        },
      });
    }
    if (parsed.pathname.endsWith("/complete")) {
      return redirected("complete") ?? fakeResponse(202, { data: canarySnapshot("UPLOADED", "STARTING") });
    }
    if (parsed.pathname === `/api/v1/imports/${CANARY_IMPORT_ID}`) {
      const redirect = redirected("poll");
      if (redirect !== null) return redirect;
      const current = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return fakeResponse(200, { data: current });
    }
    throw new Error(`unexpected HTTP request: ${options.method ?? "GET"} ${url}`);
  };
  const extraArguments = [
    "--snapshot",
    "fixtures/argus_dump.sql.gz",
    "--extracted-on",
    "2026-09-01",
    "--username",
    "operator@example.com",
    "--label",
    "phase2-canary",
    "--timeout-seconds",
    "60",
    ...(stopAtStage === null ? [] : ["--stop-at-stage", stopAtStage]),
  ];
  return {
    ...base,
    externalCalls,
    requests,
    evidenceWrites,
    confirmations,
    closedSnapshots,
    uploadedParts,
    get maximumActiveUploads() {
      return maximumActiveUploads;
    },
    get stopCalls() {
      return stopCalls;
    },
    options: {
      ...base.options,
      step: "import-canary",
      extraArguments,
      execute,
      accessFile: () => {},
      lstat: (target) =>
        path.basename(String(target)) === ".git"
          ? {
              uid: 1000,
              dev: 1,
              ino: 3,
              nlink: 1,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            }
          : {
              uid: 1000,
              dev: 1,
              ino: 2,
              nlink: 1,
              size: CANARY_PART_SIZE * 3 + 7,
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
      inspectSnapshot: () => ({
        sizeBytes: CANARY_PART_SIZE * 3 + 7,
        sha256: "f".repeat(64),
        parts,
      }),
      readSnapshotPart: (_inspection, part) => Buffer.from(`part-${part.partNumber}`),
      closeSnapshot: (inspection) => closedSnapshots.push(inspection),
      writeCanaryEvidence: (_context, configuration, contents) => {
        evidenceWrites.push({
          target: configuration.evidence,
          contents: String(contents),
          options: { mode: 0o600 },
        });
      },
      httpRequest,
      isTty: () => true,
      readSecret: async () => "super-private-password",
      confirm: async (phrase) => {
        confirmations.push(phrase);
        clock += confirmationAdvanceSeconds;
        return true;
      },
      writeFile: (target, contents, options) => {
        evidenceWrites.push({ target, contents: String(contents), options });
      },
      monotonic: () => clock,
      sleep: async (milliseconds) => {
        clock += Math.max(milliseconds / 1_000, 1);
      },
    },
  };
}

test("import-canary rejects unsafe local inputs and missing TTY before external calls", async () => {
  const valid = [
    "--snapshot",
    "fixtures/argus_dump.sql.gz",
    "--extracted-on",
    "2026-09-01",
    "--username",
    "operator@example.com",
    "--label",
    "phase2-canary",
    "--timeout-seconds",
    "60",
  ];
  const cases = [
    { label: "TTY", extraArguments: valid, isTty: () => false },
    {
      label: "basename",
      extraArguments: valid.with(1, "fixtures/not-the-dump.sql.gz"),
      isTty: () => true,
    },
    {
      label: "username",
      extraArguments: valid.with(5, "not-an-email"),
      isTty: () => true,
    },
    {
      label: "label",
      extraArguments: valid.with(7, "UPPERCASE"),
      isTty: () => true,
    },
  ];
  for (const current of cases) {
    const calls = [];
    const result = await runLearnerLab({
      step: "import-canary",
      root: ROOT,
      extraArguments: current.extraArguments,
      execute: (...args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      log: () => {},
      environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
      realpath: (target) => target,
      accessFile: () => {},
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      isTty: current.isTty,
    });
    assert.notEqual(result.status, 0, current.label);
    assert.deepEqual(calls, [], current.label);
  }

  const calls = [];
  const result = await runLearnerLab({
    step: "import-canary",
    root: ROOT,
    extraArguments: valid,
    execute: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    log: () => {},
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
    realpath: (target) => target,
    accessFile: () => {},
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }),
    isTty: () => true,
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, []);
});

test("import-canary rejects real final and parent snapshot symlinks before external calls", async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "argus-canary-snapshot-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const physical = path.join(temporary, "physical");
  mkdirSync(physical);
  const physicalSnapshot = path.join(physical, "argus_dump.sql.gz");
  writeFileSync(physicalSnapshot, "snapshot-bytes", { mode: 0o600 });
  const linkedParent = path.join(temporary, "linked-parent");
  symlinkSync(physical, linkedParent, "dir");
  const finalLinkDirectory = path.join(temporary, "final-link");
  mkdirSync(finalLinkDirectory);
  const finalLink = path.join(finalLinkDirectory, "argus_dump.sql.gz");
  symlinkSync(physicalSnapshot, finalLink, "file");

  for (const snapshot of [path.join(linkedParent, "argus_dump.sql.gz"), finalLink]) {
    const calls = [];
    const result = await runLearnerLab({
      step: "import-canary",
      root: ROOT,
      extraArguments: [
        "--snapshot",
        snapshot,
        "--extracted-on",
        "2026-09-01",
        "--username",
        "operator@example.com",
        "--label",
        "phase2-canary",
        "--timeout-seconds",
        "60",
      ],
      execute: (...args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      log: () => {},
      environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
      isTty: () => true,
    });

    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, [], snapshot);
  }
});

test("import-canary locks snapshot identity before external calls and never reopens a swapped path", async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "argus-canary-swap-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const snapshot = path.join(temporary, "argus_dump.sql.gz");
  const displaced = path.join(temporary, "original.sql.gz");
  const originalBytes = Buffer.from("original-snapshot-bytes");
  writeFileSync(snapshot, originalBytes, { mode: 0o600 });
  const a = importCanaryEnvironment();
  a.options.extraArguments[1] = snapshot;
  a.options.lstat = (target) =>
    path.basename(String(target)) === ".git"
      ? {
          uid: process.getuid(),
          dev: 1,
          ino: 3,
          nlink: 1,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }
      : String(target) === path.join(ROOT, "apps", "fullstack", "terraform.tfstate")
        ? {
            uid: process.getuid(),
            dev: 1,
            ino: 2,
            nlink: 1,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          }
      : lstatSync(target);
  a.options.accessFile = undefined;
  const originalInspection = a.options.inspectSnapshot;
  let inspected = false;
  a.options.inspectSnapshot = (target) => {
    assert.equal(target, snapshot);
    inspected = true;
    return { ...originalInspection(target), descriptor: 73 };
  };
  const originalExecute = a.options.execute;
  let swapped = false;
  a.options.execute = (...args) => {
    assert.equal(inspected, true, "snapshot must be locked before the first external command");
    if (!swapped) {
      renameSync(snapshot, displaced);
      writeFileSync(snapshot, "replacement-path-bytes", { mode: 0o600 });
      swapped = true;
    }
    return originalExecute(...args);
  };
  a.options.readSnapshotPart = (inspection, part) => {
    assert.equal(inspection.descriptor, 73);
    assert.equal(readFileSync(snapshot, "utf8"), "replacement-path-bytes");
    return Buffer.from(`part-${part.partNumber}-${originalBytes.toString("hex")}`);
  };

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(a.closedSnapshots.length, 1);
  assert.equal(a.closedSnapshots[0].descriptor, 73);
});

test("import-canary closes a locked snapshot when inspection validation fails", async () => {
  const a = importCanaryEnvironment();
  a.options.inspectSnapshot = () => ({
    descriptor: 73,
    sizeBytes: 1,
    sha256: "f".repeat(64),
    parts: [],
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.deepEqual(a.externalCalls, []);
  assert.deepEqual(a.closedSnapshots, [
    {
      descriptor: 73,
      sizeBytes: 1,
      sha256: "f".repeat(64),
      parts: [],
    },
  ]);
});

test("import-canary rejects a non-Linux evidence platform before external calls", async () => {
  const a = importCanaryEnvironment();
  a.options.platform = "darwin";

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.deepEqual(a.externalCalls, []);
  assert.deepEqual(a.requests, []);
});

test("import-canary resumes 16 MiB multipart upload with concurrency three and sanitized evidence", async () => {
  const a = importCanaryEnvironment();

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 0);
  assert.deepEqual(a.uploadedParts.sort((left, right) => left - right), [2, 3, 4]);
  assert.equal(a.maximumActiveUploads, 3);
  assert.equal(a.stopCalls, 0);
  assert.equal(a.evidenceWrites.length, 1);
  assert.equal(a.closedSnapshots.length, 1);
  assert.equal(a.evidenceWrites[0].options.mode, 0o600);
  const evidence = JSON.parse(a.evidenceWrites[0].contents);
  assert.equal(evidence.importId, CANARY_IMPORT_ID);
  assert.equal(evidence.runId, CANARY_RUN_ID);
  assert.equal(evidence.datasetVersion, `dsv_${"a".repeat(64)}`);
  assert.equal(evidence.state, "READY");
  assert.equal(evidence.faultInjected, false);
  assert.equal(evidence.partSizeBytes, CANARY_PART_SIZE);
  assert.equal(evidence.resumedParts, 1);
  assert.doesNotMatch(a.evidenceWrites[0].contents, /password|cookie|token|signature|super-private/i);
  assert.equal(
    a.requests.some((request) => request.url.endsWith("/activate")),
    false,
  );
  const signedUploads = a.requests.filter((request) => request.options.method === "PUT");
  assert.equal(
    signedUploads.every((request) =>
      Object.keys(request.options.headers).every((name) => name.toLowerCase() !== "cookie"),
    ),
    true,
  );
  assert.equal(
    a.requests
      .filter((request) => new URL(request.url).origin === CANARY_PANEL_URL)
      .every((request) => request.options.redirect === "error"),
    true,
  );
});

for (const scenario of [
  {
    label: "a missing READY candidate",
    snapshot: canarySnapshot("READY", "SUCCEEDED", { candidateVersion: null }),
  },
  {
    label: "a malformed READY candidate",
    snapshot: canarySnapshot("READY", "SUCCEEDED", {
      candidateVersion: "dsv_not-a-sha",
    }),
  },
  {
    label: "an unknown progress kind",
    snapshot: canarySnapshot("READY", "SUCCEEDED", {
      progress: { kind: "mystery" },
    }),
  },
  {
    label: "an unknown progress stage",
    snapshot: canarySnapshot("READY", "NOT_A_STAGE"),
  },
  {
    label: "a negative progress counter",
    snapshot: canarySnapshot("READY", "SUCCEEDED", {
      progress: {
        kind: "stage",
        stage: "SUCCEEDED",
        recordsRead: -1,
        recordsWritten: 23,
        recordsRejected: 0,
      },
    }),
  },
  {
    label: "a fractional progress counter",
    snapshot: canarySnapshot("READY", "SUCCEEDED", {
      progress: {
        kind: "stage",
        stage: "SUCCEEDED",
        recordsRead: 23,
        recordsWritten: 22.5,
        recordsRejected: 0,
      },
    }),
  },
  {
    label: "an open progress schema",
    snapshot: canarySnapshot("READY", "SUCCEEDED", {
      progress: {
        kind: "stage",
        stage: "SUCCEEDED",
        recordsRead: 23,
        recordsWritten: 23,
        recordsRejected: 0,
        unexpected: "must-not-reach-evidence",
      },
    }),
  },
]) {
  test(`import-canary rejects ${scenario.label} before writing evidence`, async () => {
    const a = importCanaryEnvironment({
      startSnapshot: scenario.snapshot,
      statuses: [],
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(a.evidenceWrites.length, 0);
  });
}

test("import-canary rejects non-finite observation timing before writing evidence", async () => {
  const a = importCanaryEnvironment({
    startSnapshot: canarySnapshot("READY", "SUCCEEDED"),
    statuses: [],
  });
  a.options.monotonic = () => Number.NaN;

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.evidenceWrites.length, 0);
});

test("import-canary never reports an already-active READY candidate as inactive", async () => {
  const candidateVersion = `dsv_${"a".repeat(64)}`;
  const a = importCanaryEnvironment({
    startSnapshot: canarySnapshot("READY", "SUCCEEDED", { candidateVersion }),
    statuses: [],
    activeDataset: candidateVersion,
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.evidenceWrites.length, 0);
});

for (const scenario of ["symlink", "hardlink", "existing"]) {
  test(`import-canary atomically replaces a real ${scenario} evidence entry without overwriting its victim`, async (t) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), `argus-canary-evidence-${scenario}-`));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const artifactDirectory = path.join(temporary, ".artifacts", "argus-import-canary");
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(artifactDirectory, "import-canary-phase2-canary.json");
    const victim = path.join(temporary, "victim.txt");
    writeFileSync(victim, "victim-must-remain-unchanged", { mode: 0o640 });
    if (scenario === "symlink") symlinkSync(victim, target, "file");
    if (scenario === "hardlink") linkSync(victim, target);
    if (scenario === "existing") writeFileSync(target, "stale-evidence", { mode: 0o644 });
    const originalTargetInode = scenario === "existing" ? statSync(target).ino : null;
    const a = importCanaryEnvironment({ root: temporary });
    a.options.realpath = (candidate) => (candidate === temporary ? ORIGINAL_ROOT : realpathSync(candidate));
    a.options.makeDirectory = mkdirSync;
    a.options.writeFile = writeFileSync;
    a.options.changeMode = (candidate, mode) => {
      if (candidate.startsWith(artifactDirectory)) chmodSync(candidate, mode);
    };
    a.options.currentUserId = () => process.getuid();
    a.options.writeCanaryEvidence = undefined;

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 0, a.logs.join("\n"));
    assert.equal(readFileSync(victim, "utf8"), "victim-must-remain-unchanged");
    const metadata = lstatSync(target);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o600);
    for (const directory of [
      path.dirname(artifactDirectory),
      artifactDirectory,
    ]) {
      const directoryMetadata = statSync(directory);
      assert.equal(directoryMetadata.isDirectory(), true);
      assert.equal(directoryMetadata.uid, process.getuid());
      assert.equal(directoryMetadata.nlink >= 1, true);
      assert.equal(directoryMetadata.mode & 0o777, 0o700);
    }
    if (originalTargetInode !== null) assert.notEqual(metadata.ino, originalTargetInode);
    const evidence = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(evidence.importId, CANARY_IMPORT_ID);
    assert.deepEqual(readdirSync(artifactDirectory), [path.basename(target)]);
  });
}

test("import-canary removes its exclusive evidence temporary file when publication fails", async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "argus-canary-evidence-failure-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const artifactDirectory = path.join(temporary, ".artifacts", "argus-import-canary");
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(artifactDirectory, "import-canary-phase2-canary.json");
  mkdirSync(target, { mode: 0o700 });
  const a = importCanaryEnvironment({ root: temporary });
  a.options.realpath = (candidate) => (candidate === temporary ? ORIGINAL_ROOT : realpathSync(candidate));
  a.options.makeDirectory = mkdirSync;
  a.options.writeFile = writeFileSync;
  a.options.changeMode = (candidate, mode) => {
    if (candidate.startsWith(artifactDirectory)) chmodSync(candidate, mode);
  };
  a.options.currentUserId = () => process.getuid();
  a.options.writeCanaryEvidence = undefined;

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.deepEqual(readdirSync(artifactDirectory), [path.basename(target)]);
  assert.equal(lstatSync(target).isDirectory(), true);
});

test("import-canary aborts if the evidence parent is swapped before publication", async (t) => {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "argus-canary-evidence-parent-swap-"),
  );
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const artifacts = path.join(temporary, ".artifacts");
  const artifactDirectory = path.join(artifacts, "argus-import-canary");
  const displacedArtifacts = path.join(temporary, ".artifacts-displaced");
  const target = path.join(
    artifactDirectory,
    "import-canary-phase2-canary.json",
  );
  const victim = path.join(temporary, "victim.txt");
  writeFileSync(victim, "victim-must-remain-unchanged", { mode: 0o600 });
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const a = importCanaryEnvironment({ root: temporary });
  a.options.realpath = (candidate) =>
    candidate === temporary ? ORIGINAL_ROOT : realpathSync(candidate);
  a.options.makeDirectory = mkdirSync;
  a.options.changeMode = (candidate, mode) => {
    if (candidate.startsWith(artifactDirectory)) chmodSync(candidate, mode);
  };
  a.options.currentUserId = () => process.getuid();
  a.options.writeCanaryEvidence = undefined;
  let swapped = false;
  a.options.writeFile = (descriptor, contents, options) => {
    writeFileSync(descriptor, contents, options);
    if (!swapped && Number.isInteger(descriptor)) {
      swapped = true;
      renameSync(artifacts, displacedArtifacts);
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      symlinkSync(victim, target, "file");
    }
  };

  const result = await runLearnerLab(a.options);

  assert.equal(swapped, true, a.logs.join("\n"));
  assert.equal(result.status, 1);
  assert.equal(readFileSync(victim, "utf8"), "victim-must-remain-unchanged");
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(
    readdirSync(path.join(displacedArtifacts, "argus-import-canary")),
    [],
  );
});

for (const scenario of [
  {
    label: "a non-S3 host",
    signedUrlForPart: (partNumber) => canarySignedUploadUrl(partNumber, { host: "attacker.example" }),
  },
  {
    label: "a divergent bucket",
    signedUrlForPart: (partNumber) => canarySignedUploadUrl(partNumber, { bucket: "other-private-bucket" }),
  },
  {
    label: "a divergent region",
    signedUrlForPart: (partNumber) => canarySignedUploadUrl(partNumber, { region: "eu-west-1" }),
  },
  {
    label: "a divergent path-style bucket",
    signedUrlForPart: (partNumber) =>
      canarySignedUploadUrl(partNumber, {
        host: "s3.us-east-1.amazonaws.com",
        pathName: `/other-private-bucket/imports/${CANARY_IMPORT_ID}/part-${partNumber}`,
      }),
  },
]) {
  test(`import-canary rejects signed uploads bound to ${scenario.label} before sending bytes`, async () => {
    const a = importCanaryEnvironment({
      signedUrlForPart: scenario.signedUrlForPart,
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(
      a.requests.some((request) => request.options.method === "PUT"),
      false,
    );
  });
}

for (const scenario of [
  { operation: "start", status: 301 },
  { operation: "list", status: 307 },
  { operation: "sign", status: 308 },
  { operation: "complete", status: 301 },
  {
    operation: "poll",
    status: 307,
    startSnapshot: canarySnapshot("PROCESSING"),
  },
]) {
  test(`import-canary rejects a cross-origin ${scenario.status} from authenticated ${scenario.operation}`, async () => {
    const a = importCanaryEnvironment({
      redirectAt: scenario,
      ...(scenario.startSnapshot === undefined ? {} : { startSnapshot: scenario.startSnapshot }),
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(
      a.requests.some((request) => new URL(request.url).origin === "https://attacker.example"),
      false,
    );
    assert.equal(
      a.requests
        .filter((request) => new URL(request.url).origin === CANARY_PANEL_URL)
        .every((request) => request.options.redirect === "error"),
      true,
    );
    const redirectedRequest = a.requests.at(-1);
    const redirectedUrl = new URL(redirectedRequest.url);
    const expected = {
      start: ["POST", "/api/v1/imports"],
      list: ["GET", `/api/v1/imports/${CANARY_IMPORT_ID}/parts`],
      sign: ["POST", `/api/v1/imports/${CANARY_IMPORT_ID}/parts`],
      complete: ["POST", `/api/v1/imports/${CANARY_IMPORT_ID}/complete`],
      poll: ["GET", `/api/v1/imports/${CANARY_IMPORT_ID}`],
    }[scenario.operation];
    assert.deepEqual(
      [redirectedRequest.options.method, redirectedUrl.pathname],
      expected,
      "the redirected response must be the final request",
    );
  });
}

for (const scenario of [
  {
    state: "PROCESSING",
    statuses: [canarySnapshot("READY", "SUCCEEDED")],
    expectedStatus: 0,
  },
  { state: "READY", statuses: [], expectedStatus: 0 },
  { state: "FAILED", statuses: [], expectedStatus: 1 },
]) {
  test(`import-canary resumes a settled ${scenario.state} idempotency replay without multipart mutation`, async () => {
    const a = importCanaryEnvironment({
      startSnapshot: canarySnapshot(scenario.state),
      statuses: scenario.statuses,
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, scenario.expectedStatus);
    assert.equal(a.uploadedParts.length, 0);
    assert.equal(
      a.requests.some((request) => {
        const parsed = new URL(request.url);
        return parsed.pathname.endsWith("/parts") || parsed.pathname.endsWith("/complete");
      }),
      false,
    );
  });
}

for (const divergent of [
  { fileName: "different.sql.gz" },
  { sizeBytes: CANARY_PART_SIZE * 3 + 8 },
  { snapshotExtractedOn: "2026-08-31" },
]) {
  test(`import-canary rejects an idempotency replay with divergent snapshot metadata ${JSON.stringify(divergent)}`, async () => {
    const a = importCanaryEnvironment({
      startSnapshot: canarySnapshot("UPLOADING", "STARTING", divergent),
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(
      a.requests.some((request) => new URL(request.url).pathname.endsWith("/parts")),
      false,
    );
  });
}

test("import-canary timeout never stops a task without stop-at-stage", async () => {
  const a = importCanaryEnvironment({
    statuses: [canarySnapshot("PROCESSING")],
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.stopCalls, 0);
  assert.equal(
    a.externalCalls.some(
      (call) => call.command === "aws" && call.args[0] === "ecs" && call.args[1] === "stop-task",
    ),
    false,
  );
});

test("import-canary refuses an ECS ARN divergence before stop", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    statuses: [canarySnapshot("PROCESSING")],
    describedTaskArn: CANARY_TASK_ARN.replace(/.$/, "0"),
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.stopCalls, 0);
});

test("import-canary refuses a persisted import identity divergence before stop", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    statuses: [canarySnapshot("PROCESSING")],
    persistedImportId: "imp_01K5Z9P7Z7A1B2C3D4E5F6G7H9",
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.stopCalls, 0);
});

test("import-canary refuses a task without an exact IMPORT_ID override", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    statuses: [canarySnapshot("PROCESSING")],
    includeImportIdentityOverride: false,
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.stopCalls, 0);
});

for (const scenario of [
  {
    label: "cluster",
    overrides: { taskClusterArn: `${CANARY_CLUSTER_ARN}-other` },
  },
  {
    label: "task definition",
    overrides: {
      taskDefinitionArn: CANARY_TASK_DEFINITION.replace(/:8$/, ":9"),
    },
  },
  { label: "container", overrides: { taskContainerName: "other-container" } },
  {
    label: "command",
    overrides: {
      taskCommand: ["import-dump", "--import-id", `${CANARY_IMPORT_ID}X`],
    },
  },
  { label: "pipeline", overrides: { pipelineOverride: "legacy-v1" } },
  { label: "import stage", overrides: { importStage: "ARCHIVING" } },
  { label: "run stage", overrides: { runStage: "ARCHIVING" } },
  {
    label: "duplicate IMPORT_ID",
    overrides: { importIdentityOverrideCount: 2 },
  },
  {
    label: "duplicate IMPORT_PIPELINE_VERSION",
    overrides: { pipelineOverrideCount: 2 },
  },
]) {
  test(`import-canary rejects divergent ${scenario.label} evidence before stop`, async () => {
    const a = importCanaryEnvironment({
      stopAtStage: "PROJECTING",
      startSnapshot: canarySnapshot("PROCESSING"),
      statuses: [],
      ...scenario.overrides,
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(a.stopCalls, 0);
  });
}

test("import-canary aborts when exact stage evidence becomes stale after confirmation", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    startSnapshot: canarySnapshot("PROCESSING"),
    statuses: [],
    afterConfirmationStage: "FINALIZING_CANDIDATE",
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.confirmations.length, 1);
  assert.equal(a.stopCalls, 0);
});

test("import-canary rechecks its deadline after confirmation before stop", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    startSnapshot: canarySnapshot("PROCESSING"),
    statuses: [],
    confirmationAdvanceSeconds: 61,
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.confirmations.length, 1);
  assert.equal(a.stopCalls, 0);
});

test("import-canary rechecks its deadline after post-confirmation evidence reads", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    startSnapshot: canarySnapshot("PROCESSING"),
    statuses: [],
    postConfirmationRevalidationAdvanceSeconds: 61,
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 1);
  assert.equal(a.confirmations.length, 1);
  assert.equal(a.stopCalls, 0);
});

test("import-canary stops its exact task once and waits for retryable FAILED plus lock release", async () => {
  const a = importCanaryEnvironment({
    stopAtStage: "PROJECTING",
    statuses: [canarySnapshot("PROCESSING")],
  });

  const result = await runLearnerLab(a.options);

  assert.equal(result.status, 0);
  assert.equal(a.stopCalls, 1);
  assert.deepEqual(a.confirmations, [
    `STOP 111122223333 ${CANARY_IMPORT_ID} ${CANARY_TASK_ARN}`,
  ]);
  assert.equal(
    a.externalCalls.filter(
      (call) =>
        call.command === "aws" &&
        call.args[0] === "ecs" &&
        call.args[1] === "describe-tasks",
    ).length,
    3,
  );
  const evidence = JSON.parse(a.evidenceWrites[0].contents);
  assert.equal(evidence.state, "FAILED");
  assert.equal(evidence.faultInjected, true);
  assert.equal(evidence.candidateActivated, false);
  assert.equal(
    a.externalCalls.some(
      (call) => call.command === "aws" && call.args[0] === "ecs" && call.args[1] === "list-tasks",
    ),
    false,
  );
});

for (const scenario of [
  { label: "FAILED is absent", persistFailed: false, releaseLock: true },
  {
    label: "active import lock remains",
    persistFailed: true,
    releaseLock: false,
  },
]) {
  test(`import-canary fails after one stop when ${scenario.label}`, async () => {
    const a = importCanaryEnvironment({
      stopAtStage: "PROJECTING",
      statuses: [canarySnapshot("PROCESSING")],
      persistFailed: scenario.persistFailed,
      releaseLock: scenario.releaseLock,
    });

    const result = await runLearnerLab(a.options);

    assert.equal(result.status, 1);
    assert.equal(a.stopCalls, 1);
    assert.equal(a.evidenceWrites.length, 0);
  });
}

const ANALYSIS_MODEL = path.join(ROOT, "models", "approved-model.json");
const ANALYSIS_CATALOG = path.join(ROOT, "config", "scope-catalog.pilot.json");
const ANALYSIS_ARGUMENTS = [
  "--analysis-model",
  ANALYSIS_MODEL,
  "--analysis-catalog",
  ANALYSIS_CATALOG,
];
const ANALYSIS_PLAN_VARIABLES = {
  analysis_worker_habilitado: true,
  analysis_worker_desired_count: 0,
  analysis_llm_provider: "none",
  analysis_model_file: ANALYSIS_MODEL,
  analysis_scope_catalog_file: ANALYSIS_CATALOG,
};
const OLLAMA_MODEL_ID = "qwen2.5:7b";
const OLLAMA_URL = "http://10.20.30.40:11434";
const OLLAMA_ARGUMENTS = [...ANALYSIS_ARGUMENTS, "--analysis-model-id", OLLAMA_MODEL_ID];
const OLLAMA_PLAN_VARIABLES = {
  ...ANALYSIS_PLAN_VARIABLES,
  analysis_llm_provider: "ollama",
  analysis_llm_model_id: OLLAMA_MODEL_ID,
  observabilidade_habilitada: true,
};

function analysisFiles(
  a,
  {
    model = { approved: true, datasetVersion: "dsv-1" },
    catalog = [{ id: "canal-a" }],
    symlink = false,
    invalidJson = false,
  } = {},
) {
  const documents = new Map([
    [ANALYSIS_MODEL, model],
    [ANALYSIS_CATALOG, catalog],
  ]);
  return {
    lstat: (target) =>
      documents.has(String(target))
        ? { isFile: () => true, isSymbolicLink: () => symlink, size: 1024 }
        : a.options.lstat(target),
    accessFile: () => {},
    readFile: (target, encoding) =>
      documents.has(String(target))
        ? invalidJson
          ? "{"
          : JSON.stringify(documents.get(String(target)))
        : a.options.readFile(target, encoding),
  };
}

test("deploy with the analysis worker validates the files and passes the worker variables to Terraform", async () => {
  const a = testEnvironment({ planVariableOverrides: ANALYSIS_PLAN_VARIABLES });

  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "deploy",
    extraArguments: ANALYSIS_ARGUMENTS,
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const plan = a.calls.find(
    (call) => call.command === "terraform" && call.args.includes("plan"),
  );
  for (const variable of [
    "-var=analysis_worker_habilitado=true",
    "-var=analysis_llm_provider=none",
    `-var=analysis_model_file=${ANALYSIS_MODEL}`,
    `-var=analysis_scope_catalog_file=${ANALYSIS_CATALOG}`,
  ]) {
    assert.ok(plan.args.includes(variable), variable);
  }
  assert.match(
    a.logs.join("\n"),
    /Analysis:\s+worker PREPARED, provider none, replicas 0 \(model approved-model\.json, catalog scope-catalog\.pilot\.json\)/,
  );
  assert.ok(
    a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
  );
});

test("deploy without the flags keeps the analysis worker disabled and out of the plan variables", async () => {
  const a = testEnvironment();

  const result = await runLearnerLab({ ...a.options, step: "deploy" });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const plan = a.calls.find(
    (call) => call.command === "terraform" && call.args.includes("plan"),
  );
  assert.equal(
    plan.args.some((argument) => String(argument).includes("analysis_")),
    false,
  );
  assert.match(a.logs.join("\n"), /Analysis:\s+worker DISABLED/);
});

test("setup with the analysis worker prints where to follow its logs", async () => {
  const a = testEnvironment({
    environment: {},
    planVariableOverrides: ANALYSIS_PLAN_VARIABLES,
  });

  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "setup",
    extraArguments: ["--profile", "team-profile", ...ANALYSIS_ARGUMENTS],
    readInput: async () => "admin@example.com",
    readSecret: async () => "SafePassword123!",
    confirmDeploy: async () => true,
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const output = a.logs.join("\n");
  assert.match(output, /Analysis:\s+view-show-analysis-worker \(LLM disabled\)/);
  assert.match(
    output,
    /aws logs tail \/ecs\/view-show-analysis-worker --follow --region us-east-1/,
  );
});

test("analysis worker flags are rejected before prompts or external calls when incomplete or unsafe", async () => {
  const cases = [
    { name: "model without catalog", args: ["--analysis-model", ANALYSIS_MODEL] },
    { name: "catalog without model", args: ["--analysis-catalog", ANALYSIS_CATALOG] },
    { name: "missing value", args: ["--analysis-model"] },
    {
      name: "flag used as a value",
      args: ["--analysis-model", "--analysis-catalog", ANALYSIS_CATALOG],
    },
    {
      name: "duplicate model",
      args: [
        "--analysis-model",
        ANALYSIS_MODEL,
        "--analysis-model",
        ANALYSIS_MODEL,
        "--analysis-catalog",
        ANALYSIS_CATALOG,
      ],
    },
    {
      name: "unapproved model",
      files: { model: { approved: false } },
      message: /approved bundle/,
    },
    { name: "model that is not an object", files: { model: [] }, message: /approved bundle/ },
    { name: "empty catalog", files: { catalog: [] }, message: /1 to 32 scopes/ },
    { name: "catalog that is not an array", files: { catalog: {} }, message: /1 to 32 scopes/ },
    {
      name: "symbolic link",
      files: { symlink: true },
      message: /regular non-symlink file/,
    },
    { name: "invalid JSON", files: { invalidJson: true }, message: /valid JSON file/ },
  ];

  for (const step of ["setup", "deploy"]) {
    for (const { name, args = ANALYSIS_ARGUMENTS, files, message } of cases) {
      const a = testEnvironment();
      let promptCount = 0;
      const result = await runLearnerLab({
        ...a.options,
        ...analysisFiles(a, files),
        step,
        extraArguments: args,
        readInput: async () => {
          promptCount += 1;
          return "admin@example.com";
        },
        readSecret: async () => {
          promptCount += 1;
          return "SafePassword123!";
        },
      });

      assert.equal(result.status, 2, `${step}: ${name}`);
      assert.equal(promptCount, 0, `${step}: ${name}`);
      assert.deepEqual(a.calls, [], `${step}: ${name}`);
      if (message) assert.match(a.logs.join("\n"), message, `${step}: ${name}`);
    }
  }
});

test("deploy does not accept the setup-only options", async () => {
  for (const extraArguments of [["--profile", "team-profile"], ["--yes"]]) {
    const a = testEnvironment();

    const result = await runLearnerLab({ ...a.options, step: "deploy", extraArguments });

    assert.equal(result.status, 2, extraArguments.join(" "));
    assert.deepEqual(a.calls, [], extraArguments.join(" "));
    assert.match(a.logs.join("\n"), /deploy does not support option/);
  }
});

test("deploy refuses to apply a plan whose analysis worker variables diverge from the request", async () => {
  for (const { name, overrides, options, message } of [
    {
      name: "plan enables the worker without the flags",
      overrides: { analysis_worker_habilitado: true },
      options: {},
      message: /enables the analysis worker without/,
    },
    {
      name: "plan points to a different model file",
      overrides: { ...ANALYSIS_PLAN_VARIABLES, analysis_model_file: "/tmp/other.json" },
      options: { extraArguments: ANALYSIS_ARGUMENTS },
      message: /does not match the requested analysis worker: analysis_model_file/,
    },
    {
      name: "plan enables an LLM provider",
      overrides: { ...ANALYSIS_PLAN_VARIABLES, analysis_llm_provider: "bedrock" },
      options: { extraArguments: ANALYSIS_ARGUMENTS },
      message: /does not match the requested analysis worker: analysis_llm_provider/,
    },
  ]) {
    const a = testEnvironment({ planVariableOverrides: overrides });

    const result = await runLearnerLab({
      ...a.options,
      ...(options.extraArguments ? analysisFiles(a) : {}),
      step: "deploy",
      ...options,
    });

    assert.equal(result.status, 1, name);
    assert.match(a.logs.join("\n"), message, name);
    assert.equal(
      a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")),
      false,
      name,
    );
  }
});

test("Ollama URL validation rejects credentials, URL decorations and local endpoints", () => {
  assert.equal(validateOllamaBaseUrl(`${OLLAMA_URL}/`), OLLAMA_URL);
  for (const value of [
    "ssh://10.20.30.40:11434",
    "http://user:secret@10.20.30.40:11434",
    "http://10.20.30.40:11434?token=secret",
    "http://10.20.30.40:11434#fragment",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
    "http://169.254.169.254/latest/meta-data",
    "http://8.8.8.8:11434",
    "https://ollama.internal.example/",
    "http://service.localhost:11434",
    "http://10.20.30.40:11434/api",
    "http://[2001:4860:4860::8888]:11434",
  ]) {
    assert.throws(() => validateOllamaBaseUrl(value), /VIEW_SHOW_OLLAMA_BASE_URL/);
  }
});

test("analysis-check rejects a redirected operational Terraform output", async () => {
  const a = testEnvironment({ analysisOperationOverrides: { cluster_name: "attacker-cluster" } });
  const result = await runLearnerLab({ ...a.options, step: "analysis-check" });
  assert.equal(result.status, 1);
  assert.equal(a.calls.some((call) => call.command === "aws" && call.args[1] === "run-task"), false);
  assert.match(a.logs.join("\n"), /analysis_worker_operacao/);
});

test("analysis-check rejects an ECS service that diverges from the tested operation", async () => {
  const a = testEnvironment({
    analysisServiceOverrides: {
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-ccc333", "subnet-bbb222"],
          securityGroups: ["sg-abc123"],
          assignPublicIp: "DISABLED",
        },
      },
    },
  });
  const result = await runLearnerLab({ ...a.options, step: "analysis-check" });
  assert.equal(result.status, 1);
  assert.equal(a.calls.some((call) => call.command === "aws" && call.args[1] === "run-task"), false);
  assert.match(a.logs.join("\n"), /ECS service/);
});

test("analysis-prepare keeps the Ollama endpoint out of arguments, logs and its atomic manifest", async () => {
  const a = testEnvironment({
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
    planVariableOverrides: OLLAMA_PLAN_VARIABLES,
  });
  const written = new Map();
  const renames = [];
  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "analysis-prepare",
    extraArguments: OLLAMA_ARGUMENTS,
    writeFile: (target, value, options) => written.set(String(target), { value: String(value), options }),
    renameFile: (source, target) => {
      renames.push({ source: String(source), target: String(target) });
      written.set(String(target), written.get(String(source)));
      written.delete(String(source));
    },
  });

  assert.equal(result.status, 0, a.logs.join("\n"));
  const plan = a.calls.find((call) => call.command === "terraform" && call.args.includes("plan"));
  for (const variable of [
    "-var=analysis_worker_habilitado=true",
    "-var=analysis_worker_desired_count=0",
    "-var=analysis_llm_provider=ollama",
    "-var=observabilidade_habilitada=true",
    `-var=analysis_llm_model_id=${OLLAMA_MODEL_ID}`,
  ]) assert.ok(plan.args.includes(variable), variable);
  assert.equal(plan.options.env.TF_VAR_analysis_ollama_base_url, OLLAMA_URL);
  const planPath = plan.args.find((argument) => String(argument).startsWith("-out="))?.slice(5);
  assert.match(planPath, /\.terraform-artifacts\/update-analysis-prepare-/);
  const shown = a.calls.find((call) =>
    call.command === "terraform" && call.args.includes("show") && call.args.includes("/proc/self/fd/3")
  );
  const applied = a.calls.find((call) => call.command === "terraform" && call.args.includes("apply"));
  const gate = a.calls.find((call) =>
    call.command === "node" && call.args.some((argument) => String(argument).includes("validate-analysis-worker-plan"))
  );
  assert.ok(shown.args.includes("/proc/self/fd/3"));
  assert.ok(applied.args.includes("/proc/self/fd/3"));
  assert.equal(gate.options.env.VIEW_SHOW_EXPECTED_AWS_ACCOUNT, "111122223333");
  assert.ok(a.calls.findIndex((call) => call === applied) < a.calls.findIndex((call) =>
    call.command === "terraform" && call.args.at(-1) === "analysis_worker_operacao"
  ));
  assert.equal(a.closedPlanDescriptors.length, 1);
  assert.deepEqual(a.removedArtifactFiles, [planPath]);
  assert.equal(a.removedArtifactDirectories.length, 1);
  assert.ok(a.artifactLifecycle[0].startsWith("close:"));
  assert.equal(a.calls.some((call) => call.args.some((argument) => String(argument).includes(OLLAMA_URL))), false);
  assert.doesNotMatch(a.logs.join("\n"), /10\.20\.30\.40/);
  assert.equal(renames.length, 1);
  const manifest = written.get(renames[0].target);
  assert.equal(manifest.options.mode, 0o600);
  assert.doesNotMatch(manifest.value, /10\.20\.30\.40|OLLAMA_BASE_URL/);
  assert.deepEqual(JSON.parse(manifest.value), {
    model: ANALYSIS_MODEL,
    catalog: ANALYSIS_CATALOG,
    modelId: OLLAMA_MODEL_ID,
  });
});

test("analysis-prepare uses the protected plan reference supported by each POSIX operating system", async () => {
  for (const [platform, expectedReference] of [
    ["linux", "/proc/self/fd/3"],
    ["darwin", "/dev/fd/3"],
  ]) {
    const a = testEnvironment({
      platform,
      environment: {
        AWS_PROFILE: "default",
        AWS_REGION: "us-east-1",
        VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL,
      },
      planVariableOverrides: OLLAMA_PLAN_VARIABLES,
    });
    const result = await runLearnerLab({
      ...a.options,
      ...analysisFiles(a),
      step: "analysis-prepare",
      extraArguments: OLLAMA_ARGUMENTS,
    });

    assert.equal(result.status, 0, `${platform}: ${a.logs.join("\n")}`);
    const plan = a.calls.find(
      (call) => call.command === "terraform" && call.args.includes("plan"),
    );
    const planPath = plan.args.find((argument) => String(argument).startsWith("-out=")).slice(5);
    const shown = a.calls.find(
      (call) =>
        call.command === "terraform" &&
        call.args.includes("show") &&
        call.args.includes("-json"),
    );
    const applied = a.calls.find(
      (call) => call.command === "terraform" && call.args.includes("apply"),
    );
    assert.notEqual(shown.args.at(-1), planPath, platform);
    assert.notEqual(applied.args.at(-1), planPath, platform);
    assert.equal(shown.args.at(-1), expectedReference, platform);
    assert.equal(applied.args.at(-1), expectedReference, platform);
    assert.equal(shown.options.stdio.length, 4, platform);
    assert.equal(applied.options.stdio.length, 4, platform);
  }
});

test("Windows analysis plan fails closed before Terraform can show or apply it", async () => {
  const a = testEnvironment({
    platform: "win32",
    environment: {
      AWS_PROFILE: "default",
      AWS_REGION: "us-east-1",
      VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL,
    },
    planVariableOverrides: OLLAMA_PLAN_VARIABLES,
  });
  a.options.currentUserId = () => undefined;

  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "analysis-prepare",
    extraArguments: OLLAMA_ARGUMENTS,
  });

  assert.equal(result.status, 1, a.logs.join("\n"));
  assert.equal(
    a.calls.some(
      (call) =>
        call.command === "terraform" &&
        (call.args.includes("plan") || call.args.includes("apply")),
    ),
    false,
  );
  assert.match(a.logs.join("\n"), /unsupported platform for protected Terraform plans/i);
});

test("analysis-prepare --ssh-bridge persists the bridge for activation and deactivation", async () => {
  const a = testEnvironment({
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
    planVariableOverrides: OLLAMA_PLAN_VARIABLES,
  });
  const written = new Map();
  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "analysis-prepare",
    extraArguments: [...OLLAMA_ARGUMENTS, "--ssh-bridge"],
    writeFile: (target, value) => written.set(String(target), String(value)),
    renameFile: (source, target) => written.set(String(target), written.get(String(source))),
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  const plan = a.calls.find((call) => call.command === "terraform" && call.args.includes("plan"));
  assert.equal(plan.options.env.TF_VAR_analysis_ssh_bridge_habilitado, "true");
  const manifest = JSON.parse(written.get(path.join(ROOT, "apps", "fullstack", ".terraform-artifacts", "analysis-worker.json")));
  assert.equal(manifest.sshBridge, true);
  assert.equal(Object.hasOwn(manifest, "ollamaBaseUrl"), false);

  const b = testEnvironment({
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
  });
  const reader = (aContext) => (target, encoding) => String(target).endsWith("analysis-worker.json")
    ? JSON.stringify(manifest)
    : analysisManifestReader(aContext)(target, encoding);
  const activated = await runLearnerLab({ ...b.options, step: "analysis-activate", readFile: reader(b) });
  assert.equal(activated.status, 0, b.logs.join("\n"));
  assert.equal(b.calls.find((call) => call.command === "terraform" && call.args.includes("plan")).options.env.TF_VAR_analysis_ssh_bridge_habilitado, "true");

  const c = testEnvironment({ analysisDesiredCount: 1 });
  const deactivated = await runLearnerLab({ ...c.options, step: "analysis-deactivate", readFile: reader(c) });
  assert.equal(deactivated.status, 0, c.logs.join("\n"));
  assert.equal(c.calls.find((call) => call.command === "terraform" && call.args.includes("plan")).options.env.TF_VAR_analysis_ssh_bridge_habilitado, "true");
});

test("analysis-prepare provisions missing observability before planning a fully known worker task", async () => {
  const a = testEnvironment({
    observabilityEndpoint: null,
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
    planVariableOverrides: OLLAMA_PLAN_VARIABLES,
  });
  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "analysis-prepare",
    extraArguments: OLLAMA_ARGUMENTS,
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  const plans = a.calls.filter((call) => call.command === "terraform" && call.args.includes("plan"));
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.args.some((argument) => argument === "-var=grafana_cidr_acesso=null"), false);
    assert.equal(plan.args.some((argument) => argument === "-var=bastion_admin_cidr=null"), false);
  }
  assert.ok(plans[0].args.includes("-var=observabilidade_habilitada=true"));
  assert.ok(plans[0].args.includes("-var=analysis_llm_provider=none"));
  assert.ok(plans[0].args.includes("-var=analysis_worker_habilitado=false"));
  assert.ok(plans[0].args.includes("-var=observabilidade_api_exportacao_habilitada=false"));
  assert.equal(plans[0].options.env.TF_VAR_analysis_ollama_base_url, undefined);
  assert.ok(plans[1].args.includes("-var=analysis_llm_provider=ollama"));
});

test("deploy accepts explicit Ollama configuration for a new zero-replica stack", async () => {
  const a = testEnvironment({
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
    planVariableOverrides: OLLAMA_PLAN_VARIABLES,
  });
  const result = await runLearnerLab({
    ...a.options,
    ...analysisFiles(a),
    step: "deploy",
    extraArguments: OLLAMA_ARGUMENTS,
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.match(a.logs.join("\n"), /worker PREPARED, provider ollama, replicas 0/);
});

function analysisManifestReader(a, { datasetVersion = "dsv-canary-1" } = {}) {
  const manifestPath = path.join(ROOT, "apps", "fullstack", ".terraform-artifacts", "analysis-worker.json");
  return (target, encoding) => {
    if (String(target) === manifestPath) {
      return JSON.stringify({ model: ANALYSIS_MODEL, catalog: ANALYSIS_CATALOG, modelId: OLLAMA_MODEL_ID });
    }
    if (String(target) === ANALYSIS_MODEL) {
      return JSON.stringify({ approved: true, datasetVersion });
    }
    return a.options.readFile(target, encoding);
  };
}

test("analysis-check and analysis-smoke run the expected one-off private ECS commands", async () => {
  for (const [step, entrypoint] of [
    ["analysis-check", "dist/src/bootstrap/ollama-connectivity-check.js"],
    ["analysis-smoke", "dist/src/bootstrap/ollama-observability-smoke.js"],
  ]) {
    const a = testEnvironment();
    const result = await runLearnerLab({ ...a.options, step });
    assert.equal(result.status, 0, `${step}: ${a.logs.join("\n")}`);
    const run = a.calls.find((call) => call.command === "aws" && call.args[0] === "ecs" && call.args[1] === "run-task");
    assert.ok(run);
    assert.match(run.args.join(" "), /assignPublicIp=DISABLED/);
    assert.match(run.args.join(" "), new RegExp(entrypoint.replaceAll(".", "\\.")));
    assert.ok(a.calls.some((call) => call.command === "aws" && call.args[1] === "wait"));
    assert.ok(a.calls.some((call) => call.command === "aws" && call.args[1] === "describe-tasks"));
  }
});

test("a failed analysis connectivity task prevents activation planning and apply", async () => {
  const a = testEnvironment({
    analysisTaskExitCode: 7,
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
  });
  const result = await runLearnerLab({
    ...a.options,
    step: "analysis-activate",
    readFile: analysisManifestReader(a),
  });
  assert.equal(result.status, 1);
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")), false);
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")), false);
});

test("analysis activation rejects a stopped task without the expected ECS stop code", async () => {
  const a = testEnvironment({
    analysisTaskStopCode: "TaskFailedToStart",
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
  });
  const result = await runLearnerLab({
    ...a.options,
    step: "analysis-activate",
    readFile: analysisManifestReader(a),
  });
  assert.equal(result.status, 1);
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")), false);
});

test("analysis-activate checks connectivity before its exact rollout plan", async () => {
  const a = testEnvironment({
    environment: { AWS_PROFILE: "default", AWS_REGION: "us-east-1", VIEW_SHOW_OLLAMA_BASE_URL: OLLAMA_URL },
  });
  const result = await runLearnerLab({
    ...a.options,
    step: "analysis-activate",
    readFile: analysisManifestReader(a),
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  const runIndex = a.calls.findIndex((call) => call.command === "aws" && call.args[1] === "run-task");
  const planIndex = a.calls.findIndex((call) => call.command === "terraform" && call.args.includes("plan"));
  assert.ok(runIndex >= 0 && planIndex > runIndex);
  const plan = a.calls[planIndex];
  assert.ok(plan.args.includes("-var=analysis_worker_desired_count=1"));
  assert.equal(plan.options.env.TF_VAR_analysis_ollama_base_url, OLLAMA_URL);
});

test("analysis-deactivate creates a 1-to-0 plan without a connectivity task", async () => {
  const a = testEnvironment({
    analysisDesiredCount: 1,
  });
  const result = await runLearnerLab({
    ...a.options,
    step: "analysis-deactivate",
    readFile: analysisManifestReader(a),
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(a.calls.some((call) => call.command === "aws" && call.args[1] === "run-task"), false);
  assert.ok(a.calls.some((call) => call.command === "aws" && call.args[1] === "describe-task-definition"));
  const plan = a.calls.find((call) => call.command === "terraform" && call.args.includes("plan"));
  assert.ok(plan.args.includes("-var=analysis_worker_desired_count=0"));
  assert.equal(plan.options.env.TF_VAR_analysis_ollama_base_url, OLLAMA_URL);
});

test("analysis-canary publishes one aligned global event and requires SUCCEEDED", async () => {
  const datasetVersion = "dsv-canary-2026";
  const a = testEnvironment({ analysisDesiredCount: 1, analysisCanaryInitialEmptyReads: 1 });
  const result = await runLearnerLab({
    ...a.options,
    step: "analysis-canary",
    readFile: analysisManifestReader(a, { datasetVersion }),
    generateRandomBytes: () => Buffer.alloc(16, 0xab),
  });
  assert.equal(result.status, 0, a.logs.join("\n"));
  const publish = a.calls.find((call) => call.command === "aws" && call.args[0] === "sqs");
  assert.ok(publish);
  assert.ok(!publish.args.includes("file:///dev/stdin"));
  assert.equal(publish.options.input, undefined);
  const event = JSON.parse(publish.args[publish.args.indexOf("--message-body") + 1]);
  const stateRead = a.calls.find((call) => call.command === "aws" &&
    call.args.slice(0, 2).join(" ") === "dynamodb get-item" && call.args.join(" ").includes("ANALYSIS#RUN#"));
  const stateKey = JSON.parse(stateRead.args[stateRead.args.indexOf("--key") + 1]);
  const expectedRunId = createHash("sha256")
    .update(JSON.stringify(`${event.eventType}${event.idempotencyKey}`)).digest("hex");
  assert.equal(stateKey.pk.S, `ANALYSIS#RUN#${expectedRunId}`);
  assert.equal(event.eventType, "ANOMALY_DETECTION");
  assert.equal(event.payload.datasetVersion, datasetVersion);
  assert.equal(event.payload.scope, undefined);
  assert.equal(Date.parse(event.payload.window.end) - Date.parse(event.payload.window.start), 15 * 60 * 1_000);
  assert.equal(Date.parse(event.payload.window.end) % (15 * 60 * 1_000), 0);
  assert.match(a.logs.join("\n"), /Analysis state: SUCCEEDED/);
  assert.equal(a.calls.filter((call) => call.command === "aws" && call.args.slice(0, 2).join(" ") === "dynamodb get-item").length, 2);
  assert.doesNotMatch(a.logs.join("\n"), new RegExp(datasetVersion));
});

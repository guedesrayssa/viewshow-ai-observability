// Manage the AWS Academy Learner Lab workflow through explicit, repeatable commands.
//
//   node apps/scripts/aws-learner-lab.mjs <command>
//
// Node keeps the workflow portable across Linux, macOS and Windows. Each command
// can be retried independently:
//
//   setup           deploy the stack and provision the initial Cognito user
//   check           validate prerequisites without changing AWS
//   build-snapshot  build the reduced snapshot locally
//   deploy          init, create-only plan gate, confirmation and apply
//   plan-update     validate a saved update plan without applying it
//   update          apply one hardcoded update preset through the update gate
//   seed            upload the snapshot and run a non-activating backfill
//   evidence        print durable ingestion-run evidence
//   all             run the complete workflow
//
// Terraform, snapshot upload and backfill are idempotent for the same inputs.
// This script never activates a candidate dataset; activation remains a separate,
// deliberate operation.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMANDS = [
  "setup",
  "check",
  "build-snapshot",
  "deploy",
  "destroy",
  "plan-update",
  "update",
  "seed",
  "import-canary",
  "evidence",
  "all",
];
const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const NAMESPACE = "view-show";
const STACK_NAME = "view-show-fullstack";
const REGION = "us-east-1";
const PROTECTED_COMMANDS = new Set([
  "check",
  "destroy",
  "plan-update",
  "update",
  "seed",
  "import-canary",
  "all",
]);
const MAX_COMMAND_OUTPUT_BYTES = 25 * 1024 * 1024;
const MYSQL_SNAPSHOT_IMAGE =
  "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad";
const TASK_ADDRESSES = Object.freeze([
  "aws_ecs_task_definition.api",
  "aws_ecs_task_definition.ingestion_backfill",
  "aws_ecs_task_definition.ingestion_import",
  "aws_ecs_task_definition.ingestion_sync",
  "aws_ecs_task_definition.ingestion_incremental_export",
  "aws_ecs_task_definition.ingestion_incremental_ingest",
]);
const TASK_CONTAINER_NAMES = Object.freeze({
  "aws_ecs_task_definition.api": Object.freeze([`${NAMESPACE}-iac-api`]),
  "aws_ecs_task_definition.ingestion_backfill": Object.freeze([
    "tmp-owner",
    "mysql-snapshot",
    "ingestion",
  ]),
  "aws_ecs_task_definition.ingestion_import": Object.freeze([
    "tmp-owner",
    "mysql-snapshot",
    "ingestion",
  ]),
  "aws_ecs_task_definition.ingestion_sync": Object.freeze(["tmp-owner", "ingestion"]),
  "aws_ecs_task_definition.ingestion_incremental_export": Object.freeze([
    "tmp-owner",
    "ingestion",
  ]),
  "aws_ecs_task_definition.ingestion_incremental_ingest": Object.freeze([
    "tmp-owner",
    "ingestion",
  ]),
});
const TASK_DISK_BUDGET_BYTES = Object.freeze({
  "aws_ecs_task_definition.ingestion_backfill": "68719476736",
  "aws_ecs_task_definition.ingestion_import": "68719476736",
  "aws_ecs_task_definition.ingestion_sync": "8589934592",
  "aws_ecs_task_definition.ingestion_incremental_export": "8589934592",
  "aws_ecs_task_definition.ingestion_incremental_ingest": "17179869184",
});
const UPDATE_PRESETS = Object.freeze({
  baseline: Object.freeze({
    ingestion_snapshot_page_size: 500,
    ingestion_snapshot_prepare_enabled: false,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "loadtest-20000": Object.freeze({
    ingestion_snapshot_page_size: 500,
    ingestion_snapshot_prepare_enabled: false,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 20000,
  }),
  "phase1-2000": Object.freeze({
    ingestion_snapshot_page_size: 2000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "phase1-5000": Object.freeze({
    ingestion_snapshot_page_size: 5000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "phase1-10000": Object.freeze({
    ingestion_snapshot_page_size: 10000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: false,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "phase2-2000": Object.freeze({
    ingestion_snapshot_page_size: 2000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "phase2-5000": Object.freeze({
    ingestion_snapshot_page_size: 5000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
  "phase2-10000": Object.freeze({
    ingestion_snapshot_page_size: 10000,
    ingestion_snapshot_prepare_enabled: true,
    import_canonical_first_enabled: true,
    import_hot_materialization_enabled: false,
    rate_limit_por_minuto: 180,
  }),
});
const LEARNER_LAB_PLAN_VARIABLES = Object.freeze({
  deployment_namespace: NAMESPACE,
  regiao: REGION,
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
  acoes_alarme_ingestao: [],
});
// The analysis worker is opt-in. The model and catalog are local files that
// Terraform publishes to the ingestion bucket; Bedrock is unavailable in the
// Learner Lab, so the worker always runs with the LLM disabled.
const ANALYSIS_MODEL_MAX_BYTES = 128 * 1024 * 1024;
const ANALYSIS_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const ANALYSIS_LLM_PROVIDER = "none";
// Provenance of the canonical fixture used only by the reduced smoke workflow.
// Real snapshots must provide their own extraction date to upload_snapshot.py.
const REDUCED_FIXTURE_EXTRACTED_ON = "2026-09-01";
const LEGACY_SEED_TIMEOUT_SECONDS = 600;
const SEED_POLL_INTERVAL_MILLISECONDS = 15_000;
const SEED_LABEL = /^[a-z0-9-]{1,40}$/;
const IMPORT_CANARY_PART_SIZE = 16 * 1024 * 1024;
const IMPORT_CANARY_UPLOAD_CONCURRENCY = 3;
const IMPORT_CANARY_POLL_MILLISECONDS = 5_000;
const IMPORT_CANARY_STOP_STAGES = new Set([
  "EXTRACTING",
  "ARCHIVING",
  "PROJECTING",
  "FINALIZING_CANDIDATE",
]);
const IMPORT_CANARY_STATES = new Set([
  "PREPARING",
  "UPLOADING",
  "UPLOADED",
  "VALIDATING",
  "PROCESSING",
  "READY",
  "FAILED",
]);
const IMPORT_CANARY_RUN_STAGES = new Set([
  "STARTING",
  "RESTORING",
  "VALIDATING",
  "INGESTING",
  "EXTRACTING",
  "PROJECTING",
  "ARCHIVING",
  "ACTIVATING",
  "MATERIALIZING_HOT",
  "FINALIZING_CANDIDATE",
  "PUBLISHING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "SKIPPED_LOCKED",
  "SKIPPED_DISABLED",
]);
const IMPORT_CANARY_OBSERVED_STAGES = new Set([
  ...IMPORT_CANARY_STATES,
  ...IMPORT_CANARY_RUN_STAGES,
]);
const IMPORT_CANARY_ID = /^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IMPORT_CANARY_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMPORT_CANARY_DATASET_VERSION = /^dsv_[0-9a-f]{64}$/;
const IMPORT_CANARY_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;
const HELP = `Usage: node apps/scripts/aws-learner-lab.mjs <command>
       node apps/scripts/aws-learner-lab.mjs setup [--profile <name>] [--yes] [--analysis-model <approved-model.json> --analysis-catalog <scope-catalog.json>]
       node apps/scripts/aws-learner-lab.mjs deploy [--analysis-model <approved-model.json> --analysis-catalog <scope-catalog.json>]
       node apps/scripts/aws-learner-lab.mjs destroy
       node apps/scripts/aws-learner-lab.mjs seed --snapshot <file.sql.gz> --extracted-on <YYYY-MM-DD> --label <slug> --timeout-seconds <n>
       node apps/scripts/aws-learner-lab.mjs import-canary --snapshot <argus_dump.sql.gz> --extracted-on <YYYY-MM-DD> --username <email> --label <slug> --timeout-seconds <n> [--stop-at-stage <stage>]

Commands:
  setup           Deploy the full stack and provision the initial Cognito user
  check           Validate prerequisites without changing AWS
  build-snapshot  Build the reduced snapshot locally
  deploy          Plan, validate and apply the full stack
  destroy         Destroy the full stack after an exact confirmation
  plan-update     Validate one hardcoded update preset without applying it
  update          Apply one hardcoded update preset to an existing stack
  seed            Upload the snapshot and run a non-activating backfill
  import-canary   Exercise the public multipart import without activating it
  evidence        Print the durable ingestion run evidence
  all             Run check, build-snapshot, deploy, seed and evidence`;

function readAnalysisArtifact(rawPath, label, maxBytes, { root, lstat, accessFile, readFile }) {
  const resolved = path.resolve(root, rawPath);
  let metadata;
  try {
    metadata = lstat(resolved);
  } catch {
    throw new Error(`analysis ${label} does not exist or cannot be inspected`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`analysis ${label} must be a regular non-symlink file`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`analysis ${label} exceeds ${Math.floor(maxBytes / (1024 * 1024))} MiB`);
  }
  try {
    accessFile(resolved, fsConstants.R_OK);
  } catch {
    throw new Error(`analysis ${label} must be readable`);
  }
  let document;
  try {
    document = JSON.parse(readFile(resolved, "utf8"));
  } catch {
    throw new Error(`analysis ${label} must be a valid JSON file`);
  }
  return { resolved, document };
}

function parseAnalysisWorkerFiles(rawModel, rawCatalog, files) {
  if (rawModel === undefined && rawCatalog === undefined) return null;
  if (rawModel === undefined || rawCatalog === undefined) {
    throw new Error("--analysis-model and --analysis-catalog must be passed together");
  }
  const model = readAnalysisArtifact(rawModel, "model", ANALYSIS_MODEL_MAX_BYTES, files);
  if (
    model.document === null ||
    typeof model.document !== "object" ||
    Array.isArray(model.document) ||
    model.document.approved !== true
  ) {
    throw new Error(
      "analysis model must be an approved bundle (approved: true); approve it with apps/backend/agentic/scripts/approve-model.py",
    );
  }
  const catalog = readAnalysisArtifact(rawCatalog, "catalog", ANALYSIS_CATALOG_MAX_BYTES, files);
  if (
    !Array.isArray(catalog.document) ||
    catalog.document.length === 0 ||
    catalog.document.length > 32
  ) {
    throw new Error("analysis catalog must be a JSON array with 1 to 32 scopes");
  }
  return { model: model.resolved, catalog: catalog.resolved };
}

function parseSetupConfiguration(extraArguments, files, { command = "setup" } = {}) {
  if (!Array.isArray(extraArguments)) throw new Error(`${command} arguments must be an array`);
  const acceptsProfile = command === "setup";
  let profile = "default";
  let autoApprove = false;
  let profileSeen = false;
  let analysisModel;
  let analysisCatalog;
  for (let index = 0; index < extraArguments.length; index += 1) {
    const argument = extraArguments[index];
    if (acceptsProfile && argument === "--yes") {
      if (autoApprove) throw new Error(`${command} option --yes may only be passed once`);
      autoApprove = true;
      continue;
    }
    if (acceptsProfile && argument === "--profile") {
      if (profileSeen) throw new Error(`${command} option --profile may only be passed once`);
      const value = extraArguments[index + 1];
      if (typeof value !== "string" || value.startsWith("--") || value.length === 0) {
        throw new Error(`${command} requires a value after --profile`);
      }
      if (!/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(value)) {
        throw new Error(`${command} profile contains unsupported characters`);
      }
      if (value.toLowerCase() === "nora") {
        throw new Error("the nora AWS profile is not allowed for this project");
      }
      profile = value;
      profileSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--analysis-model" || argument === "--analysis-catalog") {
      const seen = argument === "--analysis-model" ? analysisModel : analysisCatalog;
      if (seen !== undefined) {
        throw new Error(`${command} option ${argument} may only be passed once`);
      }
      const value = extraArguments[index + 1];
      if (typeof value !== "string" || value.startsWith("--") || value.length === 0) {
        throw new Error(`${command} requires a value after ${argument}`);
      }
      if (argument === "--analysis-model") analysisModel = value;
      else analysisCatalog = value;
      index += 1;
      continue;
    }
    throw new Error(`${command} does not support option: ${String(argument)}`);
  }
  const analysisWorker = parseAnalysisWorkerFiles(analysisModel, analysisCatalog, files);
  return { profile, autoApprove, analysisWorker };
}

function validateInitialUser(email, password) {
  if (!IMPORT_CANARY_EMAIL.test(email)) throw new Error("initial user email is invalid");
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new Error(
      "initial user password must have at least 8 characters, uppercase, lowercase and a number",
    );
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseSeedConfiguration({ extraArguments, root, lstat, accessFile }) {
  if (!Array.isArray(extraArguments)) throw new Error("seed arguments must be an array");
  if (extraArguments.length === 0) {
    return {
      snapshot: path.join(root, "reduced-argus.sql.gz"),
      extractedOn: REDUCED_FIXTURE_EXTRACTED_ON,
      label: "smoke",
      timeoutSeconds: LEGACY_SEED_TIMEOUT_SECONDS,
      terraformOutput: path.join(root, "terraform-output.json"),
      evidence: path.join(root, "upload-result.json"),
      custom: false,
    };
  }

  const allowed = new Set(["--snapshot", "--extracted-on", "--label", "--timeout-seconds"]);
  if (extraArguments.length % 2 !== 0) {
    throw new Error("configured seed requires all four option values");
  }
  const parsed = new Map();
  for (let index = 0; index < extraArguments.length; index += 2) {
    const option = extraArguments[index];
    const value = extraArguments[index + 1];
    if (!allowed.has(option)) throw new Error(`unknown seed argument: ${String(option)}`);
    if (parsed.has(option)) throw new Error(`duplicate seed argument: ${option}`);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`seed argument ${option} requires a value`);
    }
    parsed.set(option, value);
  }
  if (parsed.size !== allowed.size || [...allowed].some((option) => !parsed.has(option))) {
    throw new Error("configured seed requires all four options");
  }

  const rawSnapshot = parsed.get("--snapshot");
  const snapshot = path.resolve(root, rawSnapshot);
  if (!rawSnapshot.endsWith(".sql.gz")) throw new Error("seed snapshot must end in .sql.gz");
  let metadata;
  try {
    metadata = lstat(snapshot);
  } catch {
    throw new Error("seed snapshot does not exist or cannot be inspected");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("seed snapshot must be a regular non-symlink file");
  }
  try {
    accessFile(snapshot, fsConstants.R_OK);
  } catch {
    throw new Error("seed snapshot must be readable");
  }

  const extractedOn = parsed.get("--extracted-on");
  if (!isIsoDate(extractedOn)) throw new Error("seed extracted-on must be a valid ISO date");
  const label = parsed.get("--label");
  if (!SEED_LABEL.test(label)) throw new Error("seed label must match [a-z0-9-]{1,40}");
  const rawTimeout = parsed.get("--timeout-seconds");
  if (!/^\d+$/.test(rawTimeout)) {
    throw new Error("seed timeout-seconds must be an integer between 60 and 43200");
  }
  const timeoutSeconds = Number(rawTimeout);
  if (timeoutSeconds < 60 || timeoutSeconds > 43_200) {
    throw new Error("seed timeout-seconds must be between 60 and 43200");
  }
  const artifactDirectory = path.join(root, ".artifacts", "argus-benchmarks");
  return {
    snapshot,
    extractedOn,
    label,
    timeoutSeconds,
    terraformOutput: path.join(artifactDirectory, `terraform-output-${label}.json`),
    evidence: path.join(artifactDirectory, `upload-result-${label}.json`),
    artifactDirectory,
    custom: true,
  };
}

function parseImportCanaryConfiguration({
  extraArguments,
  root,
  lstat,
  accessFile,
  isTty,
}) {
  if (!Array.isArray(extraArguments)) {
    throw new Error("import-canary arguments must be an array");
  }
  const required = new Set([
    "--snapshot",
    "--extracted-on",
    "--username",
    "--label",
    "--timeout-seconds",
  ]);
  const allowed = new Set([...required, "--stop-at-stage"]);
  if (extraArguments.length % 2 !== 0) {
    throw new Error("import-canary options require values");
  }
  const parsed = new Map();
  for (let index = 0; index < extraArguments.length; index += 2) {
    const option = extraArguments[index];
    const value = extraArguments[index + 1];
    if (!allowed.has(option)) throw new Error(`unknown import-canary argument: ${String(option)}`);
    if (parsed.has(option)) throw new Error(`duplicate import-canary argument: ${option}`);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`import-canary argument ${option} requires a value`);
    }
    parsed.set(option, value);
  }
  if ([...required].some((option) => !parsed.has(option))) {
    throw new Error("import-canary requires snapshot, extraction date, username, label and timeout");
  }

  const snapshot = path.resolve(root, parsed.get("--snapshot"));
  if (path.basename(snapshot) !== "argus_dump.sql.gz") {
    throw new Error("import-canary snapshot basename must be exactly argus_dump.sql.gz");
  }
  let metadata;
  try {
    metadata = lstat(snapshot);
  } catch {
    throw new Error("import-canary snapshot does not exist or cannot be inspected");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("import-canary snapshot must be a regular non-symlink file");
  }
  try {
    accessFile(snapshot, fsConstants.R_OK);
  } catch {
    throw new Error("import-canary snapshot must be readable");
  }

  const extractedOn = parsed.get("--extracted-on");
  if (!isIsoDate(extractedOn)) {
    throw new Error("import-canary extracted-on must be a valid ISO date");
  }
  const username = parsed.get("--username");
  if (username.length > 320 || !IMPORT_CANARY_EMAIL.test(username)) {
    throw new Error("import-canary username must be a valid email address");
  }
  const label = parsed.get("--label");
  if (!SEED_LABEL.test(label)) {
    throw new Error("import-canary label must match [a-z0-9-]{1,40}");
  }
  const rawTimeout = parsed.get("--timeout-seconds");
  if (!/^\d+$/.test(rawTimeout)) {
    throw new Error("import-canary timeout-seconds must be an integer between 60 and 43200");
  }
  const timeoutSeconds = Number(rawTimeout);
  if (timeoutSeconds < 60 || timeoutSeconds > 43_200) {
    throw new Error("import-canary timeout-seconds must be between 60 and 43200");
  }
  const stopAtStage = parsed.get("--stop-at-stage") ?? null;
  if (stopAtStage !== null && !IMPORT_CANARY_STOP_STAGES.has(stopAtStage)) {
    throw new Error("import-canary stop-at-stage is not supported");
  }
  if (!isTty()) {
    throw new Error("import-canary requires an interactive TTY before external calls");
  }
  const artifactDirectory = path.join(root, ".artifacts", "argus-import-canary");
  return {
    snapshot,
    extractedOn,
    username,
    label,
    timeoutSeconds,
    stopAtStage,
    artifactDirectory,
    evidence: path.join(artifactDirectory, `import-canary-${label}.json`),
  };
}

function executeCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    ...options,
  });
  if (result.error) {
    return { status: 127, stdout: "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function awsArguments(context, args) {
  return [...args, "--region", REGION, "--profile", context.profile];
}

function terraformOptions(context, options = {}) {
  return {
    ...options,
    env: {
      ...context.environment,
      AWS_PROFILE: context.profile,
      AWS_REGION: REGION,
      AWS_DEFAULT_REGION: REGION,
    },
  };
}

/**
 * Resolve the Python virtual-environment executable on every supported platform.
 * Windows uses a different directory and executable suffix than Unix systems.
 */
function venvPython(root, platform) {
  const service = path.join(root, "apps", "backend", "ingestion-data");
  return platform === "win32"
    ? path.join(service, ".venv", "Scripts", "python.exe")
    : path.join(service, ".venv", "bin", "python");
}

/** Locate a Python 3.12 system interpreter using platform-specific command names. */
function isPython312(result) {
  const version = `${result.stdout}\n${result.stderr}`.trim();
  return result.status === 0 && /^Python 3\.12(?:\.\d+)?$/i.test(version);
}

function systemPython(execute, platform) {
  const candidates = platform === "win32"
    ? [
        { command: "py", prefixArgs: ["-3.12"] },
        { command: "python3.12", prefixArgs: [] },
        { command: "python", prefixArgs: [] },
        { command: "python3", prefixArgs: [] },
      ]
    : [
        { command: "python3.12", prefixArgs: [] },
        { command: "python3", prefixArgs: [] },
        { command: "python", prefixArgs: [] },
      ];
  for (const candidate of candidates) {
    if (isPython312(execute(candidate.command, [...candidate.prefixArgs, "--version"]))) {
      return candidate;
    }
  }
  return null;
}

function parseJsonObject(text, label) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} did not return a valid JSON object`);
  }
}

function parseVersion(text) {
  const match = String(text).match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return match.slice(1, 4).map((value) => Number(value ?? 0));
}

function versionAtLeast(version, minimum) {
  if (version === null) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

function versionBefore(version, maximum) {
  if (version === null) return false;
  for (let index = 0; index < maximum.length; index += 1) {
    if (version[index] < maximum[index]) return true;
    if (version[index] > maximum[index]) return false;
  }
  return false;
}

function terraformVersion(result) {
  if (result.status !== 0) return null;
  try {
    return parseVersion(parseJsonObject(result.stdout, "terraform version").terraform_version);
  } catch {
    return null;
  }
}

function awsCliVersion(result) {
  if (result.status !== 0) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(/aws-cli\/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1, 4).map((value) => Number(value ?? 0)) : null;
}

function assertCleanTerraformEnvironment(environment) {
  const unsupported = Object.keys(environment)
    .filter((name) => {
      const normalized = name.toUpperCase();
      return (
        normalized.startsWith("TF_VAR_") ||
        normalized === "TF_CLI_ARGS" ||
        normalized.startsWith("TF_CLI_ARGS_") ||
        normalized === "TF_WORKSPACE"
      );
    })
    .sort();
  if (unsupported.length > 0) {
    throw new Error(
      `remove hidden Terraform overrides before using the Learner Lab CLI: ${unsupported.join(", ")}`,
    );
  }
}

function assertProtectedUpdateEnvironment({ environment, root, lstat, realpath }) {
  let canonicalRoot;
  try {
    canonicalRoot = realpath(root);
  } catch {
    throw new Error("protected commands require a physical primary Git checkout");
  }
  let gitMetadata;
  try {
    gitMetadata = lstat(path.join(canonicalRoot, ".git"));
  } catch {
    throw new Error("protected commands require a physical primary Git checkout");
  }
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new Error("protected commands require a physical primary Git checkout");
  }
  if (
    Object.hasOwn(environment, "AWS_DEFAULT_PROFILE") &&
    environment.AWS_DEFAULT_PROFILE !== "default"
  ) {
    throw new Error("AWS_DEFAULT_PROFILE must be absent or exactly default");
  }
  if (Object.hasOwn(environment, "AWS_REGION") && environment.AWS_REGION !== REGION) {
    throw new Error(`AWS_REGION must be exactly ${REGION}`);
  }
  if (
    Object.hasOwn(environment, "AWS_DEFAULT_REGION") &&
    environment.AWS_DEFAULT_REGION !== REGION
  ) {
    throw new Error(`AWS_DEFAULT_REGION must be absent or exactly ${REGION}`);
  }
  const forbidden = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
  ].filter((name) => Object.hasOwn(environment, name));
  if (forbidden.length > 0) {
    throw new Error(
      `remove unsupported AWS environment bindings before using protected commands: ${forbidden.join(", ")}`,
    );
  }
}

function assertNoAutomaticVariableFiles({ readDirectory, root }) {
  const stack = path.join(root, "apps", "fullstack");
  const automaticFiles = readDirectory(stack)
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .filter((name) => {
      const normalized = name.toLowerCase();
      return (
        normalized === "terraform.tfvars" ||
        normalized === "terraform.tfvars.json" ||
        normalized.endsWith(".auto.tfvars") ||
        normalized.endsWith(".auto.tfvars.json")
      );
    })
    .sort();
  if (automaticFiles.length > 0) {
    throw new Error(
      `remove automatically loaded Terraform variable files before using the Learner Lab CLI: ${automaticFiles.join(", ")}`,
    );
  }
}

function analysisWorkerVariables(analysisWorker) {
  return [
    "-var=analysis_worker_habilitado=true",
    `-var=analysis_llm_provider=${ANALYSIS_LLM_PROVIDER}`,
    `-var=analysis_model_file=${analysisWorker.model}`,
    `-var=analysis_scope_catalog_file=${analysisWorker.catalog}`,
  ];
}

function validateAnalysisWorkerPlan(plan, analysisWorker) {
  const variables = plan.variables ?? {};
  const enabled = variables.analysis_worker_habilitado?.value;
  const planEnablesWorker = enabled === true || enabled === "true";
  if (!analysisWorker) {
    if (planEnablesWorker) {
      throw new Error(
        "the saved plan enables the analysis worker without --analysis-model and --analysis-catalog",
      );
    }
    return;
  }
  const expected = {
    analysis_worker_habilitado: [true, "true"],
    analysis_llm_provider: [ANALYSIS_LLM_PROVIDER],
    analysis_model_file: [analysisWorker.model],
    analysis_scope_catalog_file: [analysisWorker.catalog],
  };
  const mismatches = Object.entries(expected)
    .filter(([name, allowed]) => !allowed.includes(variables[name]?.value))
    .map(([name]) => name)
    .sort();
  if (mismatches.length > 0) {
    throw new Error(
      `the saved plan does not match the requested analysis worker: ${mismatches.join(", ")}`,
    );
  }
}

function validateLearnerLabPlan(plan, analysisWorker = null) {
  validateAnalysisWorkerPlan(plan, analysisWorker);
  const mismatches = Object.entries(LEARNER_LAB_PLAN_VARIABLES)
    .filter(([name, expected]) => {
      if (!Object.hasOwn(plan.variables ?? {}, name)) return true;
      const actual = plan.variables[name]?.value;
      if (typeof expected === "boolean") {
        return actual !== expected && actual !== String(expected);
      }
      if (typeof expected === "number") {
        return actual !== expected && actual !== String(expected);
      }
      return JSON.stringify(actual) !== JSON.stringify(expected);
    })
    .map(([name]) => name)
    .sort();
  if (mismatches.length > 0) {
    throw new Error(
      `the saved plan does not match the safe Learner Lab profile: ${mismatches.join(", ")}`,
    );
  }
}

function assertDefaultWorkspace(context) {
  const { execute, root } = context;
  const stack = path.join("apps", "fullstack");
  const workspace = execute(
    "terraform",
    [`-chdir=${stack}`, "workspace", "show"],
    terraformOptions(context, { cwd: root }),
  );
  if (workspace.status !== 0) {
    throw new Error(`could not read the Terraform workspace: ${workspace.stderr}`);
  }
  if (workspace.stdout.trim() !== "default") {
    throw new Error(
      `Terraform workspace must be default, but ${JSON.stringify(workspace.stdout.trim())} is selected`,
    );
  }
}

function restrictPermissions({ changeMode, platform }, target, mode) {
  if (platform !== "win32") changeMode(target, mode);
}

function readPlanSnapshot(context, target) {
  let metadata;
  try {
    metadata = context.inspectArtifactPath(target);
  } catch {
    throw new Error("the validated Terraform plan is missing");
  }
  const userId = context.currentUserId();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId ||
    (Number.isInteger(metadata.nlink) && metadata.nlink !== 1)
  ) {
    throw new Error("the validated Terraform plan is not a private regular file");
  }
  let contents;
  try {
    contents = context.readPlanFile(target);
  } catch {
    throw new Error("the validated Terraform plan could not be read");
  }
  if (!(typeof contents === "string" || ArrayBuffer.isView(contents))) {
    throw new Error("the validated Terraform plan could not be read");
  }
  const bytes = Buffer.from(contents);
  if (bytes.length === 0) throw new Error("the validated Terraform plan is empty");
  return {
    bytes,
    ...artifactIdentity(metadata),
  };
}

function assertPlanUnchanged(context, target, validatedSnapshot) {
  const current = readPlanSnapshot(context, target);
  if (
    !current.bytes.equals(validatedSnapshot.bytes) ||
    current.device !== validatedSnapshot.device ||
    current.inode !== validatedSnapshot.inode
  ) {
    throw new Error("validated Terraform plan integrity changed before apply");
  }
}

function openValidatedPlan(context, target, validatedSnapshot) {
  let descriptor;
  try {
    descriptor = context.openPlanFile(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = context.inspectPlanFile(descriptor);
    const userId = context.currentUserId();
    if (
      !metadata.isFile() ||
      !Number.isInteger(userId) ||
      metadata.uid !== userId ||
      (Number.isInteger(metadata.nlink) && metadata.nlink !== 1) ||
      (validatedSnapshot.device !== null && metadata.dev !== validatedSnapshot.device) ||
      (validatedSnapshot.inode !== null && metadata.ino !== validatedSnapshot.inode)
    ) {
      throw new Error("the validated Terraform plan descriptor changed identity");
    }
    return descriptor;
  } catch (error) {
    if (Number.isInteger(descriptor)) {
      try {
        context.closePlanFile(descriptor);
      } catch (closeError) {
        if (error instanceof Error) {
          error.planDescriptorCloseFailed = true;
          error.closeCause = closeError;
          throw error;
        }
        const primaryError = new Error("validated Terraform plan descriptor failed", {
          cause: error,
        });
        primaryError.planDescriptorCloseFailed = true;
        primaryError.closeCause = closeError;
        throw primaryError;
      }
    }
    if (error instanceof Error && error.message.includes("descriptor changed identity")) {
      throw error;
    }
    throw new Error("the validated Terraform plan could not be locked for reading");
  }
}

function artifactIdentity(metadata) {
  if (!Number.isInteger(metadata?.dev) || !Number.isInteger(metadata?.ino)) {
    throw new Error("artifact identity is unavailable");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function identityMatches(metadata, expected) {
  return (
    (metadata?.dev ?? metadata?.device) === expected.device &&
    (metadata?.ino ?? metadata?.inode) === expected.inode
  );
}

function validateArtifactParent(context, artifacts) {
  const expected = path.join(
    context.root,
    "apps",
    "fullstack",
    ".terraform-artifacts",
  );
  let metadata;
  let canonical;
  try {
    metadata = context.inspectArtifactPath(artifacts);
    canonical = context.resolveArtifactPath(artifacts);
  } catch {
    throw new Error("the Terraform artifact parent could not be verified");
  }
  const userId = context.currentUserId();
  if (
    artifacts !== expected ||
    canonical !== expected ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId
  ) {
    throw new Error("the Terraform artifact parent is not a private physical directory");
  }
  return { path: artifacts, ...artifactIdentity(metadata) };
}

function inspectArtifactIfPresent(context, target, label) {
  try {
    return context.inspectArtifactPath(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`could not inspect the private Terraform ${label}`);
  }
}

function assertArtifactParentUnchanged(context, parent) {
  const current = validateArtifactParent(context, parent.path);
  if (!identityMatches(current, parent)) {
    throw new Error("the Terraform artifact parent changed identity");
  }
}

function validateStateBackupDirectory(context, parent, target, expectedIdentity = null) {
  const expected = path.join(parent.path, "state-backups");
  let metadata;
  let canonical;
  try {
    metadata = context.inspectArtifactPath(target);
    canonical = context.resolveArtifactPath(target);
  } catch {
    throw new Error("the Terraform state backup directory could not be verified");
  }
  const userId = context.currentUserId();
  if (
    target !== expected ||
    canonical !== expected ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId
  ) {
    throw new Error("the Terraform state backup directory is not a private physical directory");
  }
  const identity = { path: target, ...artifactIdentity(metadata) };
  if (expectedIdentity !== null && !identityMatches(identity, expectedIdentity)) {
    throw new Error("the Terraform state backup directory changed identity");
  }
  return identity;
}

function assertStateBackupDestinationAbsent(context, directory, target) {
  if (path.dirname(target) !== directory.path) {
    throw new Error("refusing an unexpected Terraform state backup path");
  }
  if (inspectArtifactIfPresent(context, target, "state backup file") !== null) {
    throw new Error("refusing to overwrite an existing Terraform state backup");
  }
}

function validateStateBackupFile(context, directory, target) {
  let metadata;
  let canonical;
  try {
    metadata = context.inspectArtifactPath(target);
    canonical = context.resolveArtifactPath(target);
  } catch {
    throw new Error("the Terraform state backup file could not be verified");
  }
  const userId = context.currentUserId();
  if (
    path.dirname(target) !== directory.path ||
    canonical !== target ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId ||
    metadata.nlink !== 1
  ) {
    throw new Error("the Terraform state backup is not a private physical file");
  }
  return { path: target, ...artifactIdentity(metadata) };
}

function copyStateBackupThroughDescriptors(context, source, directory, target) {
  if (context.platform === "darwin") {
    const helper = path.join(
      context.root,
      "apps",
      "scripts",
      "terraform",
      "secure-state-backup.py",
    );
    const expected = {
      source: [source.device, source.inode],
      directory: [directory.device, directory.inode],
      lineage: source.lineage,
      serial: source.serial,
    };
    const copied = context.execute(
      "python3",
      [helper, source.path, directory.path, path.basename(target), JSON.stringify(expected)],
      { cwd: context.root },
    );
    if (copied.status !== 0) {
      throw new Error("the secure Terraform state backup could not be created");
    }
    const metadata = context.inspectArtifactPath(target);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== context.currentUserId() ||
      metadata.nlink !== 1
    ) {
      throw new Error("the Terraform state backup is not a private physical file");
    }
    return { path: target, ...artifactIdentity(metadata) };
  }
  if (
    context.platform !== "linux" ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_DIRECTORY)
  ) {
    throw new Error("secure Terraform state backups require Linux descriptor safeguards");
  }
  const userId = context.currentUserId();
  let sourceDescriptor = null;
  let directoryDescriptor = null;
  let destinationDescriptor = null;
  let primaryError = null;
  try {
    sourceDescriptor = context.openBackupPath(
      source.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const sourceMetadata = context.inspectBackupFile(sourceDescriptor);
    if (
      !sourceMetadata.isFile() ||
      sourceMetadata.isSymbolicLink?.() === true ||
      sourceMetadata.uid !== userId ||
      sourceMetadata.nlink !== 1 ||
      !identityMatches(sourceMetadata, source)
    ) {
      throw new Error("the protected Terraform state descriptor changed identity");
    }

    directoryDescriptor = context.openBackupPath(
      directory.path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const directoryMetadata = context.inspectBackupFile(directoryDescriptor);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink?.() === true ||
      directoryMetadata.uid !== userId ||
      !identityMatches(directoryMetadata, directory)
    ) {
      throw new Error("the Terraform state backup directory descriptor changed identity");
    }

    const anchoredTarget = `/proc/self/fd/${directoryDescriptor}/${path.basename(target)}`;
    destinationDescriptor = context.openBackupPath(
      anchoredTarget,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const destinationMetadata = context.inspectBackupFile(destinationDescriptor);
    if (
      !destinationMetadata.isFile() ||
      destinationMetadata.isSymbolicLink?.() === true ||
      destinationMetadata.uid !== userId ||
      destinationMetadata.nlink !== 1
    ) {
      throw new Error("the Terraform state backup descriptor is not a private regular file");
    }
    const destinationIdentity = artifactIdentity(destinationMetadata);

    const contents = context.readBackupFile(sourceDescriptor);
    if (!(typeof contents === "string" || ArrayBuffer.isView(contents))) {
      throw new Error("the protected Terraform state descriptor could not be read");
    }
    const sourceSnapshot = parseStateSnapshot(
      Buffer.from(contents).toString("utf8"),
      "Terraform state backup source",
    );
    if (sourceSnapshot.lineage !== source.lineage || sourceSnapshot.serial !== source.serial) {
      throw new Error("the protected Terraform state changed before backup");
    }
    if (!identityMatches(context.inspectBackupFile(sourceDescriptor), source)) {
      throw new Error("the protected Terraform state descriptor changed while reading");
    }
    context.writeBackupFile(destinationDescriptor, contents);
    if (
      !identityMatches(context.inspectBackupFile(destinationDescriptor), destinationIdentity) ||
      !identityMatches(context.inspectBackupFile(directoryDescriptor), directory)
    ) {
      throw new Error("the Terraform state backup descriptor changed while writing");
    }
    return { path: target, ...destinationIdentity };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let closeError = null;
    for (const descriptor of [destinationDescriptor, directoryDescriptor, sourceDescriptor]) {
      if (!Number.isInteger(descriptor)) continue;
      try {
        context.closeBackupFile(descriptor);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (primaryError === null && closeError !== null) {
      throw new Error("a secure Terraform state backup descriptor could not be closed");
    }
  }
}

function assertPrivateDirectory(context, target, expectedIdentity) {
  const metadata = inspectArtifactIfPresent(context, target, "update directory");
  if (metadata === null) return null;
  const userId = context.currentUserId();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId ||
    !identityMatches(metadata, expectedIdentity)
  ) {
    throw new Error("the private Terraform update directory changed identity");
  }
  return metadata;
}

function createExclusiveUpdatePlan(context, parent, preset) {
  const prefix = path.join(parent.path, `update-${preset}-`);
  assertArtifactParentUnchanged(context, parent);
  const directory = context.makeTemporaryDirectory(prefix);
  if (
    path.dirname(directory) !== parent.path ||
    !path.basename(directory).startsWith(`update-${preset}-`)
  ) {
    throw new Error("could not create a private Terraform plan directory");
  }

  let artifact = null;
  try {
    const metadata = context.inspectArtifactPath(directory);
    const userId = context.currentUserId();
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !Number.isInteger(userId) ||
      metadata.uid !== userId
    ) {
      throw new Error("could not verify the private Terraform plan directory");
    }
    artifact = {
      parent,
      directory,
      plan: path.join(directory, `${NAMESPACE}.tfplan`),
      ...artifactIdentity(metadata),
    };
    assertArtifactParentUnchanged(context, parent);
    assertPrivateDirectory(context, directory, artifact);
    restrictPermissions(context, directory, 0o700);
    assertPrivateDirectory(context, directory, artifact);
    return artifact;
  } catch (error) {
    if (artifact === null) {
      context.log("Terraform update directory identity was not captured; artifact retained.");
      throw error;
    }
    try {
      cleanupExclusiveUpdatePlan(context, artifact, null);
    } catch {
      context.log("Terraform update directory cleanup failed; artifact retained.");
    }
    throw error;
  }
}

function cleanupExclusiveUpdatePlan(context, artifact, validatedSnapshot) {
  const expectedPlan = path.join(artifact.directory, `${NAMESPACE}.tfplan`);
  if (
    artifact.parent?.path !== path.dirname(artifact.directory) ||
    artifact.plan !== expectedPlan ||
    path.dirname(artifact.plan) !== artifact.directory ||
    path.basename(artifact.plan) !== `${NAMESPACE}.tfplan`
  ) {
    throw new Error("refusing to clean an unexpected Terraform update artifact path");
  }
  assertArtifactParentUnchanged(context, artifact.parent);
  const directoryMetadata = assertPrivateDirectory(
    context,
    artifact.directory,
    artifact,
  );
  if (directoryMetadata === null) return;
  const userId = context.currentUserId();
  assertArtifactParentUnchanged(context, artifact.parent);
  assertPrivateDirectory(context, artifact.directory, artifact);
  restrictPermissions(context, artifact.directory, 0o700);
  assertArtifactParentUnchanged(context, artifact.parent);
  assertPrivateDirectory(context, artifact.directory, artifact);
  const planMetadata = inspectArtifactIfPresent(context, artifact.plan, "plan file");
  if (planMetadata !== null) {
    if (
      validatedSnapshot === null ||
      planMetadata.isSymbolicLink() ||
      !planMetadata.isFile() ||
      planMetadata.uid !== userId ||
      planMetadata.nlink !== 1 ||
      !identityMatches(planMetadata, validatedSnapshot)
    ) {
      throw new Error("refusing to clean an untrusted Terraform plan file");
    }
    assertArtifactParentUnchanged(context, artifact.parent);
    assertPrivateDirectory(context, artifact.directory, artifact);
    const planBeforeUnlink = inspectArtifactIfPresent(context, artifact.plan, "plan file");
    if (
      planBeforeUnlink === null ||
      planBeforeUnlink.isSymbolicLink() ||
      !planBeforeUnlink.isFile() ||
      planBeforeUnlink.uid !== userId ||
      planBeforeUnlink.nlink !== 1 ||
      !identityMatches(planBeforeUnlink, validatedSnapshot)
    ) {
      throw new Error("refusing to unlink a replaced Terraform plan file");
    }
    context.removeArtifactFile(artifact.plan);
  }
  assertArtifactParentUnchanged(context, artifact.parent);
  const directoryBeforeRemoval = assertPrivateDirectory(
    context,
    artifact.directory,
    artifact,
  );
  if (directoryBeforeRemoval === null) {
    throw new Error("refusing to remove a missing Terraform update directory");
  }
  context.removeArtifactDirectory(artifact.directory);
}

function parseStateSnapshot(text, label) {
  const state = parseJsonObject(text, label);
  if (typeof state.lineage !== "string" || state.lineage.trim().length === 0) {
    throw new Error(`${label} has no valid lineage`);
  }
  if (!Number.isInteger(state.serial) || state.serial <= 0) {
    throw new Error(`${label} has no positive integer serial`);
  }
  return { lineage: state.lineage, serial: state.serial };
}

function validateLocalState(context) {
  const { root, lstat, readFile, currentUserId } = context;
  const statePath = path.join(root, "apps", "fullstack", "terraform.tfstate");
  let metadata;
  try {
    metadata = lstat(statePath);
  } catch {
    throw new Error("the protected Terraform state is missing");
  }
  const userId = currentUserId();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !Number.isInteger(userId) ||
    metadata.uid !== userId ||
    metadata.nlink !== 1
  ) {
    throw new Error("the protected Terraform state must be a regular, owned, non-symlink file");
  }
  restrictPermissions(context, statePath, 0o600);
  let contents;
  try {
    contents = readFile(statePath, "utf8");
  } catch {
    throw new Error("the protected Terraform state could not be read");
  }
  return {
    path: statePath,
    ...artifactIdentity(metadata),
    ...parseStateSnapshot(contents, "local Terraform state"),
  };
}

function pullAndValidateState(context, expected) {
  const stack = path.join("apps", "fullstack");
  const pulled = context.execute(
    "terraform",
    [`-chdir=${stack}`, "state", "pull"],
    { cwd: context.root },
  );
  if (pulled.status !== 0) throw new Error("terraform state pull failed");
  const state = parseStateSnapshot(pulled.stdout, "terraform state pull");
  if (state.lineage !== expected.lineage) {
    throw new Error("Terraform state lineage diverged");
  }
  if (state.serial < expected.serial) {
    throw new Error("Terraform state serial regressed");
  }
  return state;
}

function readAndValidateRunbook(context, identity) {
  const stack = path.join("apps", "fullstack");
  const output = context.execute(
    "terraform",
    [`-chdir=${stack}`, "output", "-json", "ingestion_runbook"],
    { cwd: context.root },
  );
  if (output.status !== 0) throw new Error("terraform output failed");
  const runbook = parseJsonObject(output.stdout, "terraform output ingestion_runbook");
  if (runbook?.imports?.expected_bucket_owner !== identity.account) {
    throw new Error("ingestion runbook bucket owner does not match the validated AWS account");
  }
  if (
    typeof runbook?.data?.operational_table !== "string" ||
    runbook.data.operational_table.length === 0
  ) {
    throw new Error("ingestion runbook has no operational table");
  }
  return runbook;
}

function initializeAndValidateExistingStack(context, identity) {
  const localState = validateLocalState(context);
  const stack = path.join("apps", "fullstack");
  context.log("terraform init");
  const initialized = context.execute(
    "terraform",
    [`-chdir=${stack}`, "init", "-input=false"],
    { cwd: context.root },
  );
  if (initialized.status !== 0) throw new Error("terraform init failed");
  assertDefaultWorkspace(context);
  const pulledState = pullAndValidateState(context, localState);
  const runbook = readAndValidateRunbook(context, identity);
  return { localState, pulledState, runbook };
}

export function isExactConfirmation(answer, phrase) {
  return answer === phrase;
}

function checkPrerequisites(context) {
  const { execute, log, platform, root, step, exists, profile } = context;
  const missing = [];
  const awsArgs = (args) => [...args, "--profile", profile];
  const require = (label, ok, resolution) => {
    log(ok ? `  ok      ${label}` : `  missing ${label} — ${resolution}`);
    if (!ok) missing.push(label);
  };

  log("Prerequisites:");
  const needsTerraform = [
    "setup",
    "check",
    "deploy",
    "destroy",
    "plan-update",
    "update",
    "seed",
    "import-canary",
    "all",
  ].includes(step);
  const needsNode = ["setup", "check", "deploy", "plan-update", "update", "all"].includes(step);
  const needsNpm = ["setup", "check", "deploy", "plan-update", "update", "all"].includes(step);
  const needsAws = [
    "setup",
    "check",
    "deploy",
    "destroy",
    "plan-update",
    "update",
    "seed",
    "import-canary",
    "evidence",
    "all",
  ].includes(step);
  const needsDocker = ["setup", "check", "deploy", "plan-update", "update", "all"].includes(step);
  const needsPython = ["check", "build-snapshot", "update", "seed", "all"].includes(step);

  if (needsTerraform) {
    const result = execute("terraform", ["version", "-json"], terraformOptions(context));
    const version = terraformVersion(result);
    require(
      "Terraform 1.7+",
      versionAtLeast(version, [1, 7, 0]) && versionBefore(version, [2, 0, 0]),
      "install Terraform 1.7 or newer, but earlier than 2.0",
    );
  }
  if (needsNode) {
    const result = execute("node", ["--version"]);
    const version = parseVersion(result.stdout);
    const detectedVersion = result.stdout.trim();
    const nodeResolution = result.status === 0 && version !== null
      ? `detected ${detectedVersion}; install or select Node.js 22.x and rerun ` +
        "(nvm: nvm install 22 && nvm use 22)"
      : "Node.js was not detected; install Node.js 22.x and rerun";
    require(
      "Node.js 22",
      result.status === 0 &&
        versionAtLeast(version, [22, 0, 0]) &&
        versionBefore(version, [23, 0, 0]),
      nodeResolution,
    );
  }
  if (needsNpm) {
    const result = platform === "win32"
      ? execute("cmd.exe", ["/d", "/s", "/c", "npm --version"])
      : execute("npm", ["--version"]);
    require(
      "npm",
      result.status === 0 && parseVersion(result.stdout) !== null,
      "install npm for Node.js 22",
    );
  }
  if (needsAws) {
    const result = execute("aws", ["--version"]);
    require(
      "AWS CLI v2",
      awsCliVersion(result)?.[0] === 2,
      "install AWS CLI v2",
    );
  }
  if (needsDocker) {
    require(
      "docker running",
      execute("docker", ["info"]).status === 0,
      "start Docker; the apply builds and publishes two images",
    );
  }

  let python = null;
  if (needsPython) {
    const venv = venvPython(root, platform);
    const venvExists = exists(venv);
    python = venvExists
      ? (isPython312(execute(venv, ["--version"])) ? venv : null)
      : systemPython(execute, platform);
  }
  if (needsPython) require("python 3.12", python !== null, "install Python 3.12.x");

  let identity = null;
  if (needsAws && !missing.includes("AWS CLI v2")) {
    const identityCall = execute("aws", awsArgs([
      "sts",
      "get-caller-identity",
      "--output",
      "json",
      "--region",
      REGION,
    ]));
    if (identityCall.status === 0) {
      try {
        const candidate = parseJsonObject(identityCall.stdout, "aws sts get-caller-identity");
        const account = candidate.Account;
        const arn = candidate.Arn;
        if (
          typeof account !== "string" ||
          !/^\d{12}$/.test(account) ||
          typeof arn !== "string" ||
          !new RegExp(`^arn:aws:sts::${account}:assumed-role/voclabs/`).test(arn)
        ) {
          throw new Error();
        }
        identity = { account, arn };
        log(`  AWS account ${account} — voclabs role confirmed`);
      } catch {
        require(
          "Learner Lab identity",
          false,
          "use credentials for the voclabs role in the intended Learner Lab account",
        );
      }
    } else {
      require(
        "Learner Lab identity",
        false,
        "start the Learner Lab session and reload its temporary credentials",
      );
    }
  }

  // get-caller-identity may still respond after session cancellation. An
  // authorized EC2 read verifies that the temporary policy remains active.
  let credentialsActive = false;
  if (needsAws && !missing.includes("AWS CLI v2")) {
    credentialsActive =
      execute("aws", awsArgs(["ec2", "describe-vpcs", "--max-items", "1", "--region", REGION]))
        .status === 0;
    require(
      "active AWS credentials",
      credentialsActive,
      "start the Learner Lab session and reload its temporary credentials",
    );
  }

  if (
    ["setup", "check", "deploy", "plan-update", "update", "all"].includes(step) &&
    identity !== null &&
    credentialsActive
  ) {
    const keyPair = execute("aws", awsArgs([
      "ec2",
      "describe-key-pairs",
      "--key-names",
      "vockey",
      "--region",
      REGION,
      "--output",
      "json",
    ]));
    let validKeyPair = false;
    if (keyPair.status === 0) {
      try {
        const payload = parseJsonObject(keyPair.stdout, "aws ec2 describe-key-pairs");
        validKeyPair = payload.KeyPairs?.some((item) => item?.KeyName === "vockey") === true;
      } catch {
        validKeyPair = false;
      }
    }
    require(
      "vockey key pair",
      validKeyPair,
      `create or import the vockey key pair in ${REGION}`,
    );
  }

  if (missing.length > 0) {
    log("");
    log(`${missing.length} prerequisite(s) missing. Nothing was executed.`);
    return { ok: false, python };
  }
  log("");
  return { ok: true, python, identity, venv: venvPython(root, platform) };
}

function ensureVenv({ execute, log, root, platform, python, exists }) {
  const venv = venvPython(root, platform);
  if (exists(venv)) return venv;
  const service = path.join(root, "apps", "backend", "ingestion-data");
  log("Creating the ingestion virtual environment (first run only)");
  const created = execute(python.command, [
    ...python.prefixArgs,
    "-m",
    "venv",
    path.join(service, ".venv"),
  ]);
  if (created.status !== 0) throw new Error(`could not create the virtual environment: ${created.stderr}`);
  const installed = execute(venv, [
    "-m",
    "pip",
    "install",
    "--quiet",
    "-r",
    path.join(service, "requirements.txt"),
  ]);
  if (installed.status !== 0) {
    throw new Error(`could not install ingestion dependencies: ${installed.stderr}`);
  }
  return venv;
}

function buildSnapshot({ execute, log, root, venv }) {
  const service = path.join(root, "apps", "backend", "ingestion-data");
  const output = path.join(root, "reduced-argus.sql.gz");
  log("Building the reduced snapshot");
  const built = execute(venv, [
    path.join(service, "scripts", "build_reduced_snapshot.py"),
    "--output",
    output,
  ]);
  if (built.status !== 0) throw new Error(`could not build the reduced snapshot: ${built.stderr}`);
  log(built.stdout.trim());
  return output;
}

async function deploy(context) {
  const { execute, log, root, makeDirectory, identity, confirmDeploy, autoApprove, profile } = context;
  const analysisWorker = context.analysisWorker ?? null;
  const stack = path.join("apps", "fullstack");
  const plan = path.join(".terraform-artifacts", `${NAMESPACE}.tfplan`);
  const variables = [
    `-var=deployment_namespace=${NAMESPACE}`,
    `-var=regiao=${REGION}`,
    "-var=ambiente=learner-lab",
    "-var=observabilidade_habilitada=false",
    "-var=bedrock_habilitado=false",
    "-var=bastion_key_name=vockey",
    "-var=tipo_instancia_bastion=t3.micro",
    "-var=cpu_task=256",
    "-var=memoria_task=512",
    "-var=quantidade_tasks=1",
    "-var=ecs_capacidade_minima=1",
    "-var=ecs_capacidade_maxima=4",
    "-var=ingestion_backfill_cpu=2048",
    "-var=ingestion_backfill_memoria=8192",
    "-var=ingestion_backfill_ephemeral_storage_gib=200",
    "-var=ingestion_sync_cpu=1024",
    "-var=ingestion_sync_memoria=2048",
    "-var=scheduler_ingestao_habilitado=false",
    "-var=force_destroy_bucket_ingestao=true",
    "-var=force_delete_ecr_ingestao=true",
    ...(analysisWorker ? analysisWorkerVariables(analysisWorker) : []),
  ];

  log("terraform init");
  const initialized = execute(
    "terraform",
    [`-chdir=${stack}`, "init", "-input=false"],
    terraformOptions(context, { cwd: root }),
  );
  if (initialized.status !== 0) throw new Error(`terraform init failed: ${initialized.stderr}`);

  assertDefaultWorkspace(context);

  log("terraform plan");
  makeDirectory(path.join(root, stack, ".terraform-artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  restrictPermissions(context, path.join(root, stack, ".terraform-artifacts"), 0o700);
  const planned = execute(
    "terraform",
    [`-chdir=${stack}`, "plan", "-input=false", ...variables, `-out=${plan}`],
    terraformOptions(context, { cwd: root }),
  );
  if (planned.status !== 0) throw new Error(`terraform plan failed: ${planned.stderr}`);
  restrictPermissions(context, path.join(root, stack, plan), 0o600);

  // The create-only gate decides whether apply is allowed. A failed plan may
  // still leave a readable .tfplan file, so apply must never bypass this gate.
  log("gate create-only");
  const json = execute(
    "terraform",
    [`-chdir=${stack}`, "show", "-json", plan],
    terraformOptions(context, { cwd: root }),
  );
  if (json.status !== 0) throw new Error(`terraform show failed: ${json.stderr}`);
  const planJson = parseJsonObject(json.stdout, "terraform show -json");
  validateLearnerLabPlan(planJson, analysisWorker);
  const gate = execute(
    "node",
    [path.join(root, "apps", "scripts", "terraform", "validate-create-plan.mjs")],
    { cwd: root, input: json.stdout },
  );
  if (gate.status !== 0) {
    throw new Error(`the create-only gate rejected the plan; nothing was applied:\n${gate.stdout}${gate.stderr}`);
  }
  log(gate.stdout.trim().split("\n").at(-1) ?? "");

  log("");
  log("Deployment summary:");
  log(`  Stack:        ${STACK_NAME}`);
  log(`  AWS account:  ${identity.account}`);
  log(`  Region:       ${REGION}`);
  log("  Workspace:    default");
  log(`  State:        ${path.join(stack, "terraform.tfstate")}`);
  log(`  Profile:      ${profile}`);
  log("  Scope:        network, API, frontend and ingestion");
  log("  API tasks:    1 x 256 CPU / 512 MiB; autoscaling 1-4");
  log("  Backfill:     2 vCPU / 8 GiB / 200 GiB ephemeral storage");
  log("  Bastion:      t3.micro, SSH DISABLED (SSM only)");
  log("  LGTM on EC2:  DISABLED");
  log("  Scheduler:    DISABLED");
  log(
    analysisWorker
      ? `  Analysis:     worker ENABLED, LLM DISABLED (model ${path.basename(analysisWorker.model)}, catalog ${path.basename(analysisWorker.catalog)})`
      : "  Analysis:     worker DISABLED",
  );
  log("  Plan policy:  create/no-op only");
  log("  Cost notice:  AWS resources keep generating charges until they are destroyed");
  log("");
  if (!autoApprove && !(await confirmDeploy(`Deploy ${STACK_NAME} in account ${identity.account}?`))) {
    log("Deployment cancelled. Nothing was applied.");
    return false;
  }

  log("terraform apply");
  const applied = execute("terraform", [`-chdir=${stack}`, "apply", "-input=false", plan], {
    ...terraformOptions(context, { cwd: root }),
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (applied.status !== 0) throw new Error("terraform apply failed");
  return true;
}

async function destroy(context) {
  const { execute, log, root, identity, confirm, makeDirectory } = context;
  const stack = path.join("apps", "fullstack");
  const plan = path.join(".terraform-artifacts", `${NAMESPACE}.destroy.tfplan`);
  const variables = [
    `-var=deployment_namespace=${NAMESPACE}`,
    `-var=regiao=${REGION}`,
    "-var=ambiente=learner-lab",
    "-var=observabilidade_habilitada=false",
    "-var=bedrock_habilitado=false",
    "-var=bastion_key_name=vockey",
    "-var=tipo_instancia_bastion=t3.micro",
    "-var=cpu_task=256",
    "-var=memoria_task=512",
    "-var=quantidade_tasks=1",
    "-var=ecs_capacidade_minima=1",
    "-var=ecs_capacidade_maxima=4",
    "-var=ingestion_backfill_cpu=2048",
    "-var=ingestion_backfill_memoria=8192",
    "-var=ingestion_backfill_ephemeral_storage_gib=200",
    "-var=ingestion_sync_cpu=1024",
    "-var=ingestion_sync_memoria=2048",
    "-var=scheduler_ingestao_habilitado=false",
    "-var=force_destroy_bucket_ingestao=true",
    "-var=force_delete_ecr_ingestao=true",
  ];

  const localState = validateLocalState(context);
  log("terraform init");
  const initialized = execute(
    "terraform",
    [`-chdir=${stack}`, "init", "-input=false"],
    terraformOptions(context, { cwd: root }),
  );
  if (initialized.status !== 0) throw new Error(`terraform init failed: ${initialized.stderr}`);
  assertDefaultWorkspace(context);
  pullAndValidateState(context, localState);

  log("terraform plan -destroy");
  makeDirectory(path.join(root, stack, ".terraform-artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  restrictPermissions(context, path.join(root, stack, ".terraform-artifacts"), 0o700);
  const planned = execute(
    "terraform",
    [`-chdir=${stack}`, "plan", "-destroy", "-input=false", ...variables, `-out=${plan}`],
    terraformOptions(context, { cwd: root }),
  );
  if (planned.status !== 0) throw new Error(`terraform destroy plan failed: ${planned.stderr}`);
  restrictPermissions(context, path.join(root, stack, plan), 0o600);
  if (planned.stdout.trim().length > 0) log(planned.stdout.trim());

  const phrase = `DESTROY ${STACK_NAME} in account ${identity.account}`;
  log("");
  log("Destruction summary:");
  log(`  Stack:        ${STACK_NAME}`);
  log(`  AWS account:  ${identity.account}`);
  log(`  Region:       ${REGION}`);
  log("  Workspace:    default");
  log("  Scope:        all Terraform-managed resources, including ingestion bucket data and ECR images");
  log("  This action is irreversible.");
  log("");
  if (!(await confirm(phrase))) {
    log("Destruction cancelled. Nothing was applied.");
    return false;
  }

  log("terraform apply destroy plan");
  const applied = execute("terraform", [`-chdir=${stack}`, "apply", "-input=false", plan], {
    ...terraformOptions(context, { cwd: root }),
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (applied.status !== 0) throw new Error("terraform destroy apply failed");
  return true;
}

function readIngestionRunbook(context) {
  const stack = path.join("apps", "fullstack");
  const runbookResult = context.execute(
    "terraform",
    [`-chdir=${stack}`, "output", "-json", "ingestion_runbook"],
    terraformOptions(context, { cwd: context.root }),
  );
  if (runbookResult.status !== 0) {
    throw new Error(`terraform output ingestion_runbook failed: ${runbookResult.stderr}`);
  }
  return parseJsonObject(runbookResult.stdout, "terraform output ingestion_runbook");
}

function readSetupOutputs(context) {
  const stack = path.join("apps", "fullstack");
  const readRaw = (name) => {
    const result = context.execute(
      "terraform",
      [`-chdir=${stack}`, "output", "-raw", name],
      terraformOptions(context, { cwd: context.root }),
    );
    if (result.status !== 0) throw new Error(`terraform output ${name} failed: ${result.stderr}`);
    const value = result.stdout.trim();
    if (value.length === 0) throw new Error(`terraform output ${name} is empty`);
    return value;
  };
  return {
    panelUrl: readRaw("painel_url"),
    apiUrl: readRaw("api_url_https"),
    userPoolId: readRaw("cognito_user_pool_id"),
    clientId: readRaw("cognito_client_id"),
    runbook: readIngestionRunbook(context),
  };
}

function snapshotSecretArn(runbook) {
  const value = runbook?.data?.snapshot_secret_arn;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ingestion runbook does not identify the internal snapshot credential");
  }
  return value;
}

function secretHasCurrentVersion(context, secretArn) {
  const result = context.execute(
    "aws",
    awsArguments(context, [
      "secretsmanager",
      "list-secret-version-ids",
      "--secret-id",
      secretArn,
      "--include-deprecated",
      "--output",
      "json",
    ]),
    { cwd: context.root },
  );
  if (result.status !== 0) {
    throw new Error("could not inspect the internal ingestion credential");
  }
  const response = parseJsonObject(result.stdout, "aws secretsmanager list-secret-version-ids");
  return (
    Array.isArray(response.Versions) &&
    response.Versions.some(
      (version) =>
        version !== null &&
        typeof version === "object" &&
        Array.isArray(version.VersionStages) &&
        version.VersionStages.includes("AWSCURRENT"),
    )
  );
}

function ensureInternalIngestionCredential(context, runbook) {
  const secretArn = snapshotSecretArn(runbook);
  if (secretHasCurrentVersion(context, secretArn)) {
    context.log("Internal ingestion credential is ready.");
    return;
  }

  const sensitiveDirectory = context.makeSensitiveTemporaryDirectory(
    path.join(tmpdir(), "view-show-ingestion-"),
  );
  const sensitiveFile = path.join(sensitiveDirectory, "snapshot-mysql-password.txt");
  let provisioningError = null;
  try {
    const password = context.generateRandomBytes(36).toString("base64url");
    context.writeSensitiveFile(sensitiveFile, password, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const created = context.execute(
      "aws",
      awsArguments(context, [
        "secretsmanager",
        "put-secret-value",
        "--secret-id",
        secretArn,
        "--secret-string",
        pathToFileURL(sensitiveFile).href,
        "--client-request-token",
        context.generateRandomBytes(24).toString("base64url"),
      ]),
      { cwd: context.root },
    );
    if (created.status !== 0) {
      throw new Error("could not create the internal ingestion credential");
    }
  } catch (error) {
    provisioningError = error;
  }

  const cleanupFailures = [];
  try {
    context.removeSensitiveFile(sensitiveFile);
  } catch {
    cleanupFailures.push("temporary internal ingestion credential file could not be removed");
  }
  try {
    context.removeSensitiveDirectory(sensitiveDirectory);
  } catch {
    cleanupFailures.push("temporary internal ingestion credential directory could not be removed");
  }
  if (cleanupFailures.length > 0) {
    const prefix = provisioningError instanceof Error ? `${provisioningError.message}; ` : "";
    throw new Error(`${prefix}${cleanupFailures.join("; ")}`);
  }
  if (provisioningError !== null) throw provisioningError;
  if (!secretHasCurrentVersion(context, secretArn)) {
    throw new Error("internal ingestion credential has no AWSCURRENT version after creation");
  }
  context.log("Internal ingestion credential is ready.");
}

function provisionInitialCognitoUser(context, outputs, email, password) {
  const getUserArgs = awsArguments(context, [
    "cognito-idp",
    "admin-get-user",
    "--user-pool-id",
    outputs.userPoolId,
    "--username",
    email,
    "--output",
    "json",
  ]);
  const existing = context.execute("aws", getUserArgs, { cwd: context.root });
  if (existing.status !== 0) {
    if (!/UserNotFoundException/i.test(`${existing.stdout}\n${existing.stderr}`)) {
      throw new Error(`could not inspect the initial Cognito user: ${existing.stderr}`);
    }
    const created = context.execute(
      "aws",
      awsArguments(context, [
        "cognito-idp",
        "admin-create-user",
        "--user-pool-id",
        outputs.userPoolId,
        "--username",
        email,
        "--user-attributes",
        `Name=email,Value=${email}`,
        "Name=email_verified,Value=true",
        "--message-action",
        "SUPPRESS",
      ]),
      { cwd: context.root },
    );
    if (created.status !== 0) {
      throw new Error(`could not create the initial Cognito user: ${created.stderr}`);
    }
  }

  const sensitiveDirectory = context.makeSensitiveTemporaryDirectory(
    path.join(tmpdir(), "view-show-cognito-"),
  );
  const sensitiveFile = path.join(sensitiveDirectory, "set-password.json");
  let provisioningError = null;
  try {
    context.writeSensitiveFile(
      sensitiveFile,
      JSON.stringify({
        UserPoolId: outputs.userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const passwordSet = context.execute(
      "aws",
      awsArguments(context, [
        "cognito-idp",
        "admin-set-user-password",
        "--cli-input-json",
        pathToFileURL(sensitiveFile).href,
      ]),
      { cwd: context.root },
    );
    if (passwordSet.status !== 0) {
      throw new Error(`could not set the initial Cognito password: ${passwordSet.stderr}`);
    }
  } catch (error) {
    provisioningError = error;
  }
  const cleanupFailures = [];
  try {
    context.removeSensitiveFile(sensitiveFile);
  } catch {
    cleanupFailures.push("temporary Cognito password file could not be removed");
  }
  try {
    context.removeSensitiveDirectory(sensitiveDirectory);
  } catch {
    cleanupFailures.push("temporary Cognito password directory could not be removed");
  }
  if (cleanupFailures.length > 0) {
    const prefix = provisioningError instanceof Error ? `${provisioningError.message}; ` : "";
    throw new Error(`${prefix}${cleanupFailures.join("; ")}`);
  }
  if (provisioningError !== null) throw provisioningError;

  const confirmed = context.execute("aws", getUserArgs, { cwd: context.root });
  if (confirmed.status !== 0) {
    throw new Error(`could not verify the initial Cognito user: ${confirmed.stderr}`);
  }
  const user = parseJsonObject(confirmed.stdout, "aws cognito-idp admin-get-user");
  if (user.UserStatus !== "CONFIRMED") {
    throw new Error(`initial Cognito user is not CONFIRMED (status: ${String(user.UserStatus)})`);
  }
  context.log(`Initial Cognito user: ${email} (CONFIRMED)`);
}

function printSetupOutputs(context, outputs) {
  context.log("");
  context.log(`${STACK_NAME} is ready:`);
  if (typeof outputs.panelUrl === "string") context.log(`  Panel:          ${outputs.panelUrl}`);
  if (typeof outputs.apiUrl === "string") context.log(`  API:            ${outputs.apiUrl}`);
  context.log(`  Cognito pool:   ${outputs.userPoolId}`);
  if (typeof outputs.clientId === "string") context.log(`  Cognito client: ${outputs.clientId}`);
  const bucket = outputs.runbook?.storage?.bucket;
  const cluster = outputs.runbook?.runtime?.cluster_arn;
  const table = outputs.runbook?.data?.operational_table;
  if (typeof bucket === "string") context.log(`  Ingestion S3:   ${bucket}`);
  if (typeof cluster === "string") context.log(`  ECS cluster:    ${cluster}`);
  if (typeof table === "string") context.log(`  DynamoDB:       ${table}`);
  if (context.analysisWorker) {
    context.log(`  Analysis:       ${NAMESPACE}-analysis-worker (LLM disabled)`);
    context.log(
      `  Worker logs:    aws logs tail /ecs/${NAMESPACE}-analysis-worker --follow --region ${REGION}`,
    );
  }
}

function updatePlanVariables(preset) {
  const selected = UPDATE_PRESETS[preset];
  return [
    `-var=deployment_namespace=${NAMESPACE}`,
    `-var=regiao=${REGION}`,
    "-var=ambiente=learner-lab",
    "-var=observabilidade_habilitada=false",
    "-var=bedrock_habilitado=false",
    "-var=bastion_key_name=vockey",
    "-var=tipo_instancia_bastion=t3.micro",
    "-var=cpu_task=256",
    "-var=memoria_task=512",
    "-var=quantidade_tasks=1",
    "-var=ecs_capacidade_minima=1",
    "-var=ecs_capacidade_maxima=4",
    "-var=ingestion_backfill_cpu=2048",
    "-var=ingestion_backfill_memoria=8192",
    "-var=ingestion_backfill_ephemeral_storage_gib=200",
    "-var=ingestion_sync_cpu=1024",
    "-var=ingestion_sync_memoria=2048",
    "-var=scheduler_ingestao_habilitado=false",
    "-var=force_destroy_bucket_ingestao=true",
    "-var=force_delete_ecr_ingestao=true",
    `-var=ingestion_snapshot_page_size=${selected.ingestion_snapshot_page_size}`,
    `-var=ingestion_snapshot_prepare_enabled=${selected.ingestion_snapshot_prepare_enabled}`,
    `-var=import_canonical_first_enabled=${selected.import_canonical_first_enabled}`,
    `-var=import_hot_materialization_enabled=${selected.import_hot_materialization_enabled}`,
    `-var=rate_limit_por_minuto=${selected.rate_limit_por_minuto}`,
    "-var=import_canonical_first_production_approved=false",
  ];
}

function assertNoActiveImport(context, runbook) {
  const key = JSON.stringify({
    pk: { S: "CONTROL#IMPORT" },
    sk: { S: "ACTIVE" },
  });
  const result = context.execute("aws", [
    "dynamodb",
    "get-item",
    "--table-name",
    runbook.data.operational_table,
    "--key",
    key,
    "--consistent-read",
    "--region",
    REGION,
    "--output",
    "json",
    "--profile",
    "default",
  ]);
  if (result.status !== 0) {
    throw new Error("could not verify the active import control record");
  }
  // AWS CLI v2 may render an empty successful GetItem result as no bytes
  // instead of `{}` when the requested key does not exist.
  if (result.stdout.trim() === "") return;
  const response = parseJsonObject(result.stdout, "dynamodb get-item");
  if (!Object.hasOwn(response, "Item")) return;
  const importId = response.Item?.importId?.S;
  if (typeof importId !== "string" || importId.length === 0) {
    throw new Error("an active import exists but its public importId is invalid");
  }
  throw new Error(`active import ${importId} prevents task-definition updates`);
}

function flattenStateResources(module, destination = []) {
  if (module === null || typeof module !== "object" || Array.isArray(module)) {
    return destination;
  }
  if (Array.isArray(module.resources)) destination.push(...module.resources);
  if (Array.isArray(module.child_modules)) {
    for (const child of module.child_modules) flattenStateResources(child, destination);
  }
  return destination;
}

function parseTaskContainers(serialized, label) {
  let containers;
  try {
    containers = JSON.parse(serialized);
  } catch {
    throw new Error(`could not read container definitions for ${label}`);
  }
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new Error(`container definitions are incomplete for ${label}`);
  }
  const byName = new Map();
  for (const container of containers) {
    if (
      typeof container?.name !== "string" ||
      container.name.length === 0 ||
      typeof container.image !== "string" ||
      container.image.length === 0 ||
      byName.has(container.name)
    ) {
      throw new Error(`container definitions are invalid for ${label}`);
    }
    byName.set(container.name, container);
  }
  return byName;
}

function unknownValuePresent(value) {
  if (value === null || value === undefined || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.some(unknownValuePresent);
  if (typeof value === "object") return Object.values(value).some(unknownValuePresent);
  return true;
}

function containsProtectedTaskUnknown(value) {
  if (Array.isArray(value)) return value.some(containsProtectedTaskUnknown);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([name, child]) =>
      (["container_definitions", "ephemeral_storage"].includes(name) &&
        unknownValuePresent(child)) ||
      containsProtectedTaskUnknown(child),
  );
}

function taskEnvironment(container, label) {
  if (!Array.isArray(container?.environment)) {
    throw new Error(`task environment is incomplete for ${label}`);
  }
  const environment = new Map();
  for (const item of container.environment) {
    if (
      typeof item?.name !== "string" ||
      typeof item?.value !== "string" ||
      environment.has(item.name)
    ) {
      throw new Error(`task environment is invalid for ${label}`);
    }
    environment.set(item.name, item.value);
  }
  return environment;
}

function expectedTaskImagesFromPlan(plan, accountId) {
  if (containsProtectedTaskUnknown(plan.proposed_unknown ?? {})) {
    throw new Error("validated plan leaves protected task values unknown");
  }
  const apiImage =
    plan.planned_values?.outputs?.imagem_ecr?.value ??
    plan.output_changes?.imagem_ecr?.after;
  const ingestionImage =
    plan.planned_values?.outputs?.ingestion_runbook?.value?.image?.immutable_uri ??
    plan.output_changes?.ingestion_runbook?.after?.image?.immutable_uri;
  if (
    typeof apiImage !== "string" ||
    !/(?::[0-9a-f]{12}|@sha256:[0-9a-f]{64})$/.test(apiImage)
  ) {
    throw new Error("validated plan has no verifiable API image output");
  }
  const proposedUnknownLeaf =
    plan.proposed_unknown?.outputs?.ingestion_runbook?.value?.image?.immutable_uri;
  const outputAfterUnknownLeaf =
    plan.output_changes?.ingestion_runbook?.after_unknown?.image?.immutable_uri;
  const ingestionImageIsUnknown =
    outputAfterUnknownLeaf === true &&
    (proposedUnknownLeaf === undefined || proposedUnknownLeaf === true);
  const ingestionImageHasUnknownValue =
    ingestionImage === undefined || ingestionImage === null;
  if (
    !/^\d{12}$/.test(accountId) ||
    (ingestionImageHasUnknownValue && !ingestionImageIsUnknown) ||
    (!ingestionImageHasUnknownValue &&
      (typeof ingestionImage !== "string" ||
        !/@sha256:[0-9a-f]{64}$/.test(ingestionImage)))
  ) {
    throw new Error("validated plan has no verifiable ingestion image output");
  }
  const changes = new Map(
    plan.resource_changes
      .filter((change) => change && typeof change.address === "string")
      .map((change) => [change.address, change]),
  );
  const plannedResources = new Map(
    flattenStateResources(plan.planned_values?.root_module)
      .filter((resource) => resource && typeof resource.address === "string")
      .map((resource) => [resource.address, resource]),
  );
  const priorResources = new Map(
    flattenStateResources(plan.prior_state?.values?.root_module)
      .filter((resource) => resource && typeof resource.address === "string")
      .map((resource) => [resource.address, resource]),
  );
  const plannedEcrImage =
    changes.get("data.aws_ecr_image.ingestion[0]") ??
    plannedResources.get("data.aws_ecr_image.ingestion[0]") ??
    priorResources.get("data.aws_ecr_image.ingestion[0]");
  const plannedImageBuild =
    changes.get("terraform_data.ingestion_image[0]") ??
    plannedResources.get("terraform_data.ingestion_image[0]");
  const plannedEcrValues = plannedEcrImage?.change?.after ?? plannedEcrImage?.values;
  const plannedImageBuildValues =
    plannedImageBuild?.change?.after ?? plannedImageBuild?.values;
  const ingestionRepositoryName = plannedEcrValues?.repository_name;
  const ingestionImageTag = plannedEcrValues?.image_tag;
  const ingestionDigest = plannedEcrValues?.image_digest;
  const ingestionDigestIsUnknown =
    plannedEcrImage?.change?.after_unknown?.image_digest === true;
  const triggersReplace = plannedImageBuildValues?.triggers_replace;
  const ingestionSourceHash =
    Array.isArray(triggersReplace) && triggersReplace.length === 1
      ? triggersReplace[0]
      : null;
  if (
    plannedEcrImage?.mode !== "data" ||
    plannedEcrImage?.type !== "aws_ecr_image" ||
    plannedImageBuild?.mode !== "managed" ||
    plannedImageBuild?.type !== "terraform_data" ||
    ingestionRepositoryName !== `${NAMESPACE}-ingestion` ||
    !/^[0-9a-f]{64}$/.test(ingestionSourceHash ?? "") ||
    ingestionImageTag !== ingestionSourceHash.slice(0, 12) ||
    (ingestionImageHasUnknownValue &&
      ((ingestionDigest !== null && ingestionDigest !== undefined) ||
        !ingestionDigestIsUnknown)) ||
    (!ingestionImageHasUnknownValue &&
      (ingestionDigestIsUnknown ||
        ingestionDigest !== ingestionImage.slice(ingestionImage.lastIndexOf("@") + 1))) ||
    (!ingestionImageHasUnknownValue &&
      !ingestionImage.startsWith(
        `${accountId}.dkr.ecr.${REGION}.amazonaws.com/${ingestionRepositoryName}@`,
      ))
  ) {
    throw new Error("validated plan has no verifiable ECR image lookup");
  }
  const expected = new Map();
  for (const address of TASK_ADDRESSES) {
    const resourceChange = changes.get(address);
    if (!resourceChange) {
      throw new Error(`validated plan is missing ${address}`);
    }
    const serialized = resourceChange.change?.after?.container_definitions;
    const requiredNames = TASK_CONTAINER_NAMES[address];
    const images = new Map();
    const afterUnknown = resourceChange.change?.after_unknown ?? {};
    if (
      typeof serialized !== "string" ||
      containsProtectedTaskUnknown(afterUnknown)
    ) {
      throw new Error(`validated plan has unknown container definitions for ${address}`);
    }
    const containers = parseTaskContainers(serialized, address);
    if (
      containers.size !== requiredNames.length ||
      requiredNames.some((name) => !containers.has(name))
    ) {
      throw new Error(`validated plan has unexpected containers for ${address}`);
    }
    for (const name of requiredNames) images.set(name, containers.get(name).image);

    for (const [name, image] of images) {
      if (name === "mysql-snapshot" && image !== MYSQL_SNAPSHOT_IMAGE) {
        throw new Error("validated plan changed the fixed MySQL snapshot image");
      }
      if (address === "aws_ecs_task_definition.api" && image !== apiImage) {
        throw new Error("validated plan API image diverged from its output");
      }
      if (
        address !== "aws_ecs_task_definition.api" &&
        name !== "mysql-snapshot" &&
        !ingestionImageHasUnknownValue &&
        image !== ingestionImage
      ) {
        throw new Error("validated plan ingestion image diverged from its output");
      }
      if (
        image !== null &&
        (address === "aws_ecs_task_definition.api"
          ? !/(?::[0-9a-f]{12}|@sha256:[0-9a-f]{64})$/.test(image)
          : !/@sha256:[0-9a-f]{64}$/.test(image))
      ) {
        throw new Error(`validated plan has a mutable image for ${address}`);
      }
    }
    expected.set(address, images);
  }
  return {
    taskImages: expected,
    ingestionRepositoryName,
    ingestionImageTag,
    accountId,
  };
}

function ingestionImageFromProviderState(byAddress, expectedPlan) {
  const repository = byAddress.get("aws_ecr_repository.ingestion");
  const image = byAddress.get("data.aws_ecr_image.ingestion[0]");
  const repositoryName = expectedPlan.ingestionRepositoryName;
  const repositoryUrl = repository?.values?.repository_url;
  const digest = image?.values?.image_digest;
  if (
    repository?.mode !== "managed" ||
    repository?.type !== "aws_ecr_repository" ||
    repository?.values?.name !== repositoryName ||
    typeof repositoryUrl !== "string" ||
    repositoryUrl !==
      `${expectedPlan.accountId}.dkr.ecr.${REGION}.amazonaws.com/${repositoryName}` ||
    image?.mode !== "data" ||
    image?.type !== "aws_ecr_image" ||
    image?.values?.repository_name !== repositoryName ||
    image?.values?.image_tag !== expectedPlan.ingestionImageTag ||
    !/^sha256:[0-9a-f]{64}$/.test(digest ?? "")
  ) {
    throw new Error("post-apply ECR image resolution is incomplete");
  }
  return `${repositoryUrl}@${digest}`;
}

function verifyPostApplyResources(state, runbook, preset, expectedPlanImages) {
  const rootModule = state?.values?.root_module;
  const resources = flattenStateResources(rootModule);
  const byAddress = new Map(
    resources
      .filter((resource) => resource && typeof resource.address === "string")
      .map((resource) => [resource.address, resource]),
  );
  const ingestionImage = ingestionImageFromProviderState(byAddress, expectedPlanImages);
  if (runbook?.image?.immutable_uri !== ingestionImage) {
    throw new Error("post-apply ingestion image output diverged from ECR resolution");
  }
  const taskArns = new Map();
  const taskContainers = new Map();
  for (const address of TASK_ADDRESSES) {
    const resource = byAddress.get(address);
    if (
      typeof resource?.values?.arn !== "string" ||
      !/^arn:aws:ecs:us-east-1:[0-9]{12}:task-definition\/[A-Za-z0-9_-]+:[1-9][0-9]*$/.test(
        resource.values.arn,
      )
    ) {
      throw new Error(`post-apply verification is missing ${address}`);
    }
    const containers = parseTaskContainers(resource.values.container_definitions, address);
    if (
      address !== "aws_ecs_task_definition.api" &&
      (!Array.isArray(resource.values.ephemeral_storage) ||
        resource.values.ephemeral_storage.length !== 1 ||
        resource.values.ephemeral_storage[0]?.size_in_gib !== 200)
    ) {
      throw new Error(`post-apply ephemeral storage diverged for ${address}`);
    }
    const expectedImages = expectedPlanImages.taskImages.get(address);
    if (
      !(expectedImages instanceof Map) ||
      containers.size !== expectedImages.size ||
      [...expectedImages.keys()].some((name) => !containers.has(name))
    ) {
      throw new Error(`post-apply containers diverged for ${address}`);
    }
    const imagePattern =
      address === "aws_ecs_task_definition.api"
        ? /(?::[0-9a-f]{12}|@sha256:[0-9a-f]{64})$/
        : /@sha256:[0-9a-f]{64}$/;
    for (const [name, container] of containers) {
      const expectedImage = expectedImages.get(name);
      const configurationImage =
        address !== "aws_ecs_task_definition.api" && name !== "mysql-snapshot"
          ? ingestionImage
          : expectedImage;
      if (
        !imagePattern.test(container.image) ||
        (name === "mysql-snapshot" && container.image !== MYSQL_SNAPSHOT_IMAGE) ||
        (expectedImage !== null && container.image !== expectedImage) ||
        container.image !== configurationImage
      ) {
        throw new Error(`post-apply image reference diverged for ${address}`);
      }
    }
    taskContainers.set(address, containers);
    taskArns.set(address, resource.values.arn);
  }

  const expectedOutputArns = new Map([
    ["aws_ecs_task_definition.ingestion_backfill", runbook?.runtime?.backfill_task_arn],
    ["aws_ecs_task_definition.ingestion_import", runbook?.runtime?.import_task_arn],
    ["aws_ecs_task_definition.ingestion_sync", runbook?.runtime?.sync_task_arn],
    [
      "aws_ecs_task_definition.ingestion_incremental_export",
      runbook?.incremental?.export_task_arn,
    ],
    [
      "aws_ecs_task_definition.ingestion_incremental_ingest",
      runbook?.incremental?.ingest_task_arn,
    ],
  ]);
  for (const [address, outputArn] of expectedOutputArns) {
    if (taskArns.get(address) !== outputArn) {
      throw new Error(`post-apply task definition output diverged for ${address}`);
    }
  }
  if (
    runbook?.imports?.task_definition_arn !==
    taskArns.get("aws_ecs_task_definition.ingestion_import")
  ) {
    throw new Error("post-apply import task definition output diverged");
  }

  const service = byAddress.get("aws_ecs_service.api");
  if (
    service?.values?.task_definition !==
    taskArns.get("aws_ecs_task_definition.api")
  ) {
    throw new Error("post-apply API service is not using the validated task definition");
  }

  const schedules = new Map([
    [
      "aws_scheduler_schedule.ingestion_sync",
      "aws_ecs_task_definition.ingestion_sync",
    ],
    [
      "aws_scheduler_schedule.ingestion_incremental_export",
      "aws_ecs_task_definition.ingestion_incremental_export",
    ],
    [
      "aws_scheduler_schedule.ingestion_incremental_ingest",
      "aws_ecs_task_definition.ingestion_incremental_ingest",
    ],
  ]);
  for (const [scheduleAddress, taskAddress] of schedules) {
    const schedule = byAddress.get(scheduleAddress);
    const targetArn = schedule?.values?.target?.[0]?.ecs_parameters?.[0]?.task_definition_arn;
    if (targetArn !== taskArns.get(taskAddress)) {
      throw new Error(`post-apply schedule target diverged for ${scheduleAddress}`);
    }
  }

  const selected = UPDATE_PRESETS[preset];
  const apiEnvironment = taskEnvironment(
    taskContainers.get("aws_ecs_task_definition.api")?.get(`${NAMESPACE}-iac-api`),
    "aws_ecs_task_definition.api",
  );
  if (
    apiEnvironment.get("IMPORT_CANONICAL_FIRST_ENABLED") !==
      String(selected.import_canonical_first_enabled) ||
    apiEnvironment.get("RATE_LIMIT_PER_MINUTE") !==
      String(selected.rate_limit_por_minuto)
  ) {
    throw new Error("post-apply API flags or rate limit diverged from the preset");
  }
  for (const [address, diskBudgetBytes] of Object.entries(TASK_DISK_BUDGET_BYTES)) {
    const environment = taskEnvironment(
      taskContainers.get(address)?.get("ingestion"),
      address,
    );
    if (
      environment.get("INGESTION_DISK_BUDGET_BYTES") !== diskBudgetBytes
    ) {
      throw new Error(`post-apply disk budget diverged for ${address}`);
    }
    if (
      [
        "aws_ecs_task_definition.ingestion_backfill",
        "aws_ecs_task_definition.ingestion_import",
      ].includes(address) &&
      (environment.get("PAGE_SIZE") !== String(selected.ingestion_snapshot_page_size) ||
        environment.get("MYSQL_SNAPSHOT_PREPARE_ENABLED") !==
          String(selected.ingestion_snapshot_prepare_enabled) ||
        environment.get("IMPORT_HOT_MATERIALIZATION_ENABLED") !==
          String(selected.import_hot_materialization_enabled))
    ) {
      throw new Error(`post-apply preset flags diverged for ${address}`);
    }
  }
}

function validateCurrentTerraformState(context, runbook, preset, expectedPlanImages) {
  const stack = path.join("apps", "fullstack");
  const shown = context.execute(
    "terraform",
    [`-chdir=${stack}`, "show", "-json"],
    { cwd: context.root },
  );
  if (shown.status !== 0) throw new Error("terraform show -json failed after apply");
  const state = parseJsonObject(shown.stdout, "terraform show -json current state");
  verifyPostApplyResources(state, runbook, preset, expectedPlanImages);
}

async function updateExistingStack(context, existingStack) {
  const {
    execute,
    log,
    root,
    makeDirectory,
    now,
    identity,
    preset,
    confirm,
    step,
  } = context;
  const stack = path.join("apps", "fullstack");
  const artifacts = path.join(root, stack, ".terraform-artifacts");

  assertNoActiveImport(context, existingStack.runbook);
  makeDirectory(artifacts, { recursive: true, mode: 0o700 });
  const artifactParent = validateArtifactParent(context, artifacts);
  restrictPermissions(context, artifacts, 0o700);
  assertArtifactParentUnchanged(context, artifactParent);
  const updateArtifact = createExclusiveUpdatePlan(context, artifactParent, preset);
  const plan = updateArtifact.plan;
  let validatedPlanSnapshot = null;
  let planDescriptor = null;
  let primaryError = null;
  let descriptorCloseFailed = false;

  try {
    log(`terraform plan (${preset})`);
    const planned = execute(
      "terraform",
      [
        `-chdir=${stack}`,
        "plan",
        "-input=false",
        ...updatePlanVariables(preset),
        `-out=${plan}`,
      ],
      { cwd: root },
    );
    if (planned.status !== 0) throw new Error("terraform update plan failed");
    restrictPermissions(context, plan, 0o400);
    validatedPlanSnapshot = readPlanSnapshot(context, plan);
    planDescriptor = openValidatedPlan(context, plan, validatedPlanSnapshot);
    const descriptorPath = process.platform === "darwin"
      ? "/dev/fd/3"
      : "/proc/self/fd/3";

    const shown = execute(
      "terraform",
      [`-chdir=${stack}`, "show", "-json", descriptorPath],
      { cwd: root, stdio: ["ignore", "pipe", "pipe", planDescriptor] },
    );
    if (shown.status !== 0) throw new Error("terraform show failed for the saved update plan");
    const planJson = parseJsonObject(shown.stdout, "terraform show -json update plan");
    const validated = execute(
      "node",
      [
        path.join(root, "apps", "scripts", "terraform", "validate-learner-update-plan.mjs"),
        preset,
      ],
      { cwd: root, input: shown.stdout },
    );
    if (validated.status !== 0) {
      throw new Error(`the Learner Lab update gate rejected the plan: ${validated.stderr}`);
    }
    const expectedPlanImages = expectedTaskImagesFromPlan(planJson, identity.account);
    restrictPermissions(context, updateArtifact.directory, 0o500);
    log(validated.stdout.trim().split("\n").at(-1) ?? "");
    if (step === "plan-update") return true;

    const confirmationPhrase = `UPDATE ${NAMESPACE} ${identity.account} ${preset}`;
    log("");
    log("Update summary:");
    log(`  AWS account: ${identity.account}`);
    log(`  Region:      ${REGION}`);
    log("  Profile:     default");
    log("  Workspace:   default");
    log(`  Preset:      ${preset}`);
    log("  Plan policy: stateless update allowlist");
    if (!(await confirm(confirmationPhrase))) {
      log("Update cancelled. Nothing was applied.");
      return false;
    }

    const backupDirectory = path.join(artifacts, "state-backups");
    assertArtifactParentUnchanged(context, artifactParent);
    makeDirectory(backupDirectory, { recursive: true, mode: 0o700 });
    const backupDirectoryIdentity = validateStateBackupDirectory(
      context,
      artifactParent,
      backupDirectory,
    );
    restrictPermissions(context, backupDirectory, 0o700);
    assertArtifactParentUnchanged(context, artifactParent);
    validateStateBackupDirectory(
      context,
      artifactParent,
      backupDirectory,
      backupDirectoryIdentity,
    );
    const timestamp = now().toISOString().replaceAll(/[:.]/g, "-");
    const backupPath = path.join(backupDirectory, `terraform.tfstate.${timestamp}`);
    assertStateBackupDestinationAbsent(context, backupDirectoryIdentity, backupPath);
    assertArtifactParentUnchanged(context, artifactParent);
    validateStateBackupDirectory(
      context,
      artifactParent,
      backupDirectory,
      backupDirectoryIdentity,
    );
    const backupIdentity = copyStateBackupThroughDescriptors(
      context,
      existingStack.localState,
      backupDirectoryIdentity,
      backupPath,
    );
    assertArtifactParentUnchanged(context, artifactParent);
    validateStateBackupDirectory(
      context,
      artifactParent,
      backupDirectory,
      backupDirectoryIdentity,
    );
    const finalBackupIdentity = validateStateBackupFile(
      context,
      backupDirectoryIdentity,
      backupPath,
    );
    if (!identityMatches(finalBackupIdentity, backupIdentity)) {
      throw new Error("the Terraform state backup changed identity");
    }

    assertPlanUnchanged(context, plan, validatedPlanSnapshot);
    assertNoActiveImport(context, existingStack.runbook);
    log("terraform apply validated update plan");
    const applied = execute(
      "terraform",
      [`-chdir=${stack}`, "apply", "-input=false", descriptorPath],
      { cwd: root, stdio: ["ignore", "inherit", "inherit", planDescriptor] },
    );
    if (applied.status !== 0) throw new Error("terraform update apply failed");

    const localState = validateLocalState(context);
    if (
      localState.lineage !== existingStack.pulledState.lineage ||
      localState.serial < existingStack.pulledState.serial
    ) {
      throw new Error("local Terraform state diverged after apply");
    }
    pullAndValidateState(context, localState);
    const runbook = readAndValidateRunbook(context, identity);
    validateCurrentTerraformState(context, runbook, preset, expectedPlanImages);
    return true;
  } catch (error) {
    primaryError = error;
    descriptorCloseFailed = error?.planDescriptorCloseFailed === true;
    throw error;
  } finally {
    let closeError = descriptorCloseFailed ? primaryError : null;
    if (Number.isInteger(planDescriptor)) {
      try {
        context.closePlanFile(planDescriptor);
      } catch (error) {
        closeError = error;
      }
    }
    if (closeError !== null) {
      context.log("Validated plan descriptor close failed; private artifact retained.");
      if (primaryError === null) {
        throw new Error("could not close the validated Terraform plan", {
          cause: closeError,
        });
      }
    } else {
      try {
        cleanupExclusiveUpdatePlan(context, updateArtifact, validatedPlanSnapshot);
      } catch (cleanupError) {
        context.log("Terraform update artifact cleanup failed; private artifact retained.");
        if (primaryError === null) {
          throw new Error("could not securely clean the Terraform update artifact", {
            cause: cleanupError,
          });
        }
      }
    }
  }
}

function inspectCanarySnapshot(snapshot) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("import-canary snapshot locking requires O_NOFOLLOW support");
  }
  const resolved = path.resolve(snapshot);
  if (path.basename(resolved) !== "argus_dump.sql.gz") {
    throw new Error("import-canary snapshot basename must be exactly argus_dump.sql.gz");
  }
  const parsed = path.parse(resolved);
  let component = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let pathMetadata;
  try {
    for (const [index, name] of components.entries()) {
      component = path.join(component, name);
      pathMetadata = lstatSync(component);
      if (pathMetadata.isSymbolicLink() || (index < components.length - 1 && !pathMetadata.isDirectory())) {
        throw new Error("import-canary snapshot path contains a symlink or non-directory");
      }
    }
    if (realpathSync(resolved) !== resolved) {
      throw new Error("import-canary snapshot path is not physical");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("import-canary")) throw error;
    throw new Error("import-canary snapshot path could not be verified");
  }

  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = openSync(resolved, flags);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > 5 * 1024 ** 3 ||
      before.nlink !== 1 ||
      pathMetadata?.dev !== before.dev ||
      pathMetadata?.ino !== before.ino
    ) {
      throw new Error("import-canary snapshot size must be between 1 byte and 5 GiB");
    }
    const digest = createHash("sha256");
    const parts = [];
    let offset = 0;
    let partNumber = 1;
    while (offset < before.size) {
      const sizeBytes = Math.min(IMPORT_CANARY_PART_SIZE, before.size - offset);
      const body = Buffer.allocUnsafe(sizeBytes);
      let filled = 0;
      while (filled < sizeBytes) {
        const count = readSync(descriptor, body, filled, sizeBytes - filled, offset + filled);
        if (count === 0) throw new Error("import-canary snapshot changed while hashing");
        filled += count;
      }
      digest.update(body);
      parts.push({
        partNumber,
        offset,
        sizeBytes,
        checksumSha256: createHash("sha256").update(body).digest("base64"),
      });
      offset += sizeBytes;
      partNumber += 1;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.nlink !== before.nlink
    ) {
      throw new Error("import-canary snapshot changed while hashing");
    }
    return {
      sizeBytes: before.size,
      sha256: digest.digest("hex"),
      parts,
      descriptor,
      identity: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
      },
    };
  } catch (error) {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
    throw error;
  }
}

function readCanarySnapshotPart(inspection, part) {
  const descriptor = inspection?.descriptor;
  if (!Number.isInteger(descriptor)) {
    throw new Error("import-canary snapshot descriptor is unavailable");
  }
  const metadata = fstatSync(descriptor);
  const expected = inspection?.identity;
  if (
    !metadata.isFile() ||
    metadata.size !== inspection.sizeBytes ||
    metadata.nlink !== 1 ||
    (expected !== undefined &&
      (metadata.dev !== expected.dev ||
        metadata.ino !== expected.ino ||
        metadata.mtimeMs !== expected.mtimeMs))
  ) {
    throw new Error("import-canary snapshot changed before upload");
  }
  const body = Buffer.allocUnsafe(part.sizeBytes);
  let filled = 0;
  while (filled < body.length) {
    const count = readSync(
      descriptor,
      body,
      filled,
      body.length - filled,
      part.offset + filled,
    );
    if (count === 0) throw new Error("import-canary snapshot was truncated before upload");
    filled += count;
  }
  const checksum = createHash("sha256").update(body).digest("base64");
  if (checksum !== part.checksumSha256) {
    throw new Error("import-canary snapshot part changed before upload");
  }
  return body;
}

function closeCanarySnapshot(inspection) {
  if (Number.isInteger(inspection?.descriptor)) closeSync(inspection.descriptor);
}

function validateCanaryInspection(inspection) {
  if (
    inspection?.sizeBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(inspection?.sha256 ?? "") ||
    !Array.isArray(inspection?.parts) ||
    inspection.parts.length === 0 ||
    inspection.parts.some(
      (part, index) =>
        part?.partNumber !== index + 1 ||
        part?.offset !== index * IMPORT_CANARY_PART_SIZE ||
        !Number.isInteger(part?.sizeBytes) ||
        part.sizeBytes <= 0 ||
        part.sizeBytes > IMPORT_CANARY_PART_SIZE ||
        (index < inspection.parts.length - 1 && part.sizeBytes !== IMPORT_CANARY_PART_SIZE) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(part?.checksumSha256 ?? ""),
    ) ||
    inspection.parts.reduce((total, part) => total + part.sizeBytes, 0) !== inspection.sizeBytes
  ) {
    throw new Error("import-canary snapshot inspection is invalid");
  }
  return inspection;
}

function stableCanaryIdempotencyKey(configuration, inspection, action) {
  return `canary-${configuration.label}-${inspection.sha256.slice(0, 40)}-${action}`;
}

function importCanaryData(payload, label) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} returned an invalid JSON document`);
  }
  const data = payload.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label} returned no data`);
  }
  return data;
}

async function parseHttpJson(response, label) {
  if (!response || typeof response.status !== "number" || typeof response.json !== "function") {
    throw new Error(`${label} returned an invalid HTTP response`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  return importCanaryData(payload, label);
}

function canaryObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function canaryClosedObject(value, allowed, required, label) {
  const item = canaryObject(value, label);
  const keys = Object.keys(item);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(item, key))
  ) {
    throw new Error(`${label} differs from the closed schema`);
  }
  return item;
}

function canaryNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canaryPositiveInteger(value, label) {
  const integer = canaryNonNegativeInteger(value, label);
  if (integer === 0) throw new Error(`${label} must be positive`);
  return integer;
}

function canaryBoundedText(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function canaryTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !IMPORT_CANARY_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function validateCanaryProgress(value, label) {
  const item = canaryObject(value, `${label} progress`);
  if (item.kind === "none") {
    canaryClosedObject(item, new Set(["kind"]), ["kind"], `${label} progress`);
    return { kind: "none" };
  }
  if (item.kind === "bytes") {
    canaryClosedObject(
      item,
      new Set(["kind", "completedBytes", "totalBytes"]),
      ["kind", "completedBytes", "totalBytes"],
      `${label} progress`,
    );
    const completedBytes = canaryNonNegativeInteger(
      item.completedBytes,
      `${label} progress.completedBytes`,
    );
    const totalBytes = canaryPositiveInteger(
      item.totalBytes,
      `${label} progress.totalBytes`,
    );
    if (completedBytes > totalBytes) {
      throw new Error(`${label} progress.completedBytes exceeds totalBytes`);
    }
    return { kind: "bytes", completedBytes, totalBytes };
  }
  if (item.kind !== "stage") {
    throw new Error(`${label} progress.kind is invalid`);
  }
  const allowed = new Set([
    "kind",
    "stage",
    "substage",
    "stageStartedAt",
    "heartbeatAt",
    "recordsRead",
    "recordsWritten",
    "recordsRejected",
    "recordsTotal",
    "currentDataset",
    "currentPartition",
    "datasetsCompleted",
    "datasetsTotal",
    "unitsCompleted",
    "unitsTotal",
    "unitLabel",
  ]);
  canaryClosedObject(
    item,
    allowed,
    ["kind", "stage", "recordsRead", "recordsWritten", "recordsRejected"],
    `${label} progress`,
  );
  if (!IMPORT_CANARY_RUN_STAGES.has(item.stage)) {
    throw new Error(`${label} progress.stage is invalid`);
  }
  const result = {
    kind: "stage",
    stage: item.stage,
    recordsRead: canaryNonNegativeInteger(
      item.recordsRead,
      `${label} progress.recordsRead`,
    ),
    recordsWritten: canaryNonNegativeInteger(
      item.recordsWritten,
      `${label} progress.recordsWritten`,
    ),
    recordsRejected: canaryNonNegativeInteger(
      item.recordsRejected,
      `${label} progress.recordsRejected`,
    ),
  };
  for (const field of ["substage", "currentPartition"]) {
    if (Object.hasOwn(item, field)) {
      result[field] = canaryBoundedText(
        item[field],
        `${label} progress.${field}`,
      );
    }
  }
  const detailFields = [
    "stageStartedAt",
    "heartbeatAt",
    "recordsTotal",
    "currentDataset",
    "datasetsCompleted",
    "datasetsTotal",
  ];
  const detailsPresent = detailFields.filter((field) =>
    Object.hasOwn(item, field),
  ).length;
  if (detailsPresent !== 0 && detailsPresent !== detailFields.length) {
    throw new Error(`${label} progress detail must be complete`);
  }
  if (detailsPresent !== 0) {
    result.stageStartedAt = canaryTimestamp(
      item.stageStartedAt,
      `${label} progress.stageStartedAt`,
    );
    result.heartbeatAt = canaryTimestamp(
      item.heartbeatAt,
      `${label} progress.heartbeatAt`,
    );
    if (Date.parse(result.heartbeatAt) < Date.parse(result.stageStartedAt)) {
      throw new Error(`${label} progress heartbeat precedes its stage`);
    }
    result.recordsTotal =
      item.recordsTotal === null
        ? null
        : canaryNonNegativeInteger(
            item.recordsTotal,
            `${label} progress.recordsTotal`,
          );
    if (
      result.recordsTotal !== null &&
      result.recordsRead > result.recordsTotal
    ) {
      throw new Error(`${label} progress.recordsRead exceeds recordsTotal`);
    }
    result.currentDataset =
      item.currentDataset === null
        ? null
        : canaryBoundedText(
            item.currentDataset,
            `${label} progress.currentDataset`,
          );
    result.datasetsCompleted = canaryNonNegativeInteger(
      item.datasetsCompleted,
      `${label} progress.datasetsCompleted`,
    );
    result.datasetsTotal = canaryNonNegativeInteger(
      item.datasetsTotal,
      `${label} progress.datasetsTotal`,
    );
    if (result.datasetsCompleted > result.datasetsTotal) {
      throw new Error(
        `${label} progress.datasetsCompleted exceeds datasetsTotal`,
      );
    }
  }
  const unitFields = ["unitsCompleted", "unitsTotal", "unitLabel"];
  const unitsPresent = unitFields.filter((field) =>
    Object.hasOwn(item, field),
  ).length;
  if (unitsPresent !== 0 && unitsPresent !== unitFields.length) {
    throw new Error(`${label} progress unit detail must be complete`);
  }
  if (unitsPresent !== 0) {
    result.unitsCompleted = canaryNonNegativeInteger(
      item.unitsCompleted,
      `${label} progress.unitsCompleted`,
    );
    result.unitsTotal = canaryNonNegativeInteger(
      item.unitsTotal,
      `${label} progress.unitsTotal`,
    );
    if (result.unitsCompleted > result.unitsTotal) {
      throw new Error(`${label} progress.unitsCompleted exceeds unitsTotal`);
    }
    result.unitLabel = canaryBoundedText(
      item.unitLabel,
      `${label} progress.unitLabel`,
    );
  }
  return result;
}

function validateCanarySnapshot(
  snapshot,
  importId,
  label,
  configuration,
  inspection,
) {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.importId !== importId ||
    snapshot.fileName !== "argus_dump.sql.gz" ||
    snapshot.sizeBytes !== inspection.sizeBytes ||
    snapshot.snapshotExtractedOn !== configuration.extractedOn ||
    !IMPORT_CANARY_STATES.has(snapshot.state) ||
    (snapshot.candidateVersion !== null &&
      !IMPORT_CANARY_DATASET_VERSION.test(snapshot.candidateVersion ?? "")) ||
    (snapshot.state === "READY" &&
      !IMPORT_CANARY_DATASET_VERSION.test(snapshot.candidateVersion ?? ""))
  ) {
    throw new Error(`${label} returned a divergent import identity or state`);
  }
  return {
    ...snapshot,
    candidateVersion: snapshot.candidateVersion,
    progress: validateCanaryProgress(snapshot.progress, label),
  };
}

function canaryApiHeaders(cookie, additional = {}) {
  return {
    Accept: "application/json",
    ...(cookie === null ? {} : { Cookie: cookie }),
    ...additional,
  };
}

async function canaryApiJson(context, url, options, label) {
  const response = await context.httpRequest(url, {
    ...options,
    redirect: "error",
  });
  return parseHttpJson(response, label);
}

function exactQueryValue(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function validateCanarySignedUploadUrl(value, bucket) {
  let signedUrl;
  try {
    signedUrl = new URL(value);
  } catch {
    throw new Error("sign import parts returned an invalid signed URL");
  }
  const virtualHosts = new Set([`${bucket}.s3.${REGION}.amazonaws.com`, `${bucket}.s3.amazonaws.com`]);
  const pathHosts = new Set([`s3.${REGION}.amazonaws.com`, "s3.amazonaws.com"]);
  const virtualBound = virtualHosts.has(signedUrl.hostname) && signedUrl.pathname.length > 1;
  const pathPrefix = `/${bucket}/`;
  const pathBound =
    pathHosts.has(signedUrl.hostname) &&
    signedUrl.pathname.startsWith(pathPrefix) &&
    signedUrl.pathname.length > pathPrefix.length;
  const credential = exactQueryValue(signedUrl, "X-Amz-Credential");
  const algorithm = exactQueryValue(signedUrl, "X-Amz-Algorithm");
  const signature = exactQueryValue(signedUrl, "X-Amz-Signature");
  if (
    signedUrl.protocol !== "https:" ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.port ||
    signedUrl.hash ||
    (!virtualBound && !pathBound) ||
    algorithm !== "AWS4-HMAC-SHA256" ||
    !/^[^/]+\/\d{8}\/us-east-1\/s3\/aws4_request$/.test(credential ?? "") ||
    !/^[0-9a-f]{64}$/i.test(signature ?? "")
  ) {
    throw new Error("signed upload URL is not bound to the validated S3 bucket and region");
  }
  return signedUrl;
}

async function runWithConcurrency(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await operation(items[index]);
    }
  });
  await Promise.all(workers);
}

function awsOperationalItem(context, tableName, key, label) {
  const result = context.execute("aws", [
    "dynamodb",
    "get-item",
    "--table-name",
    tableName,
    "--key",
    JSON.stringify(key),
    "--consistent-read",
    "--region",
    REGION,
    "--output",
    "json",
    "--profile",
    "default",
  ]);
  if (result.status !== 0) throw new Error(`${label} could not be read`);
  return parseJsonObject(result.stdout, label).Item ?? null;
}

function dynamoString(item, name) {
  const value = item?.[name]?.S;
  return typeof value === "string" ? value : null;
}

function dynamoBoolean(item, name) {
  const value = item?.[name]?.BOOL;
  return typeof value === "boolean" ? value : null;
}

function readActiveDatasetVersion(context, tableName) {
  const item = awsOperationalItem(
    context,
    tableName,
    { pk: { S: "CONTROL#DATASET" }, sk: { S: "ACTIVE" } },
    "active dataset",
  );
  const datasetVersion = dynamoString(item, "activeDatasetVersion");
  if (datasetVersion === null) throw new Error("active dataset identity is missing");
  return datasetVersion;
}

function describeExactCanaryTask(context, runbook, taskArn) {
  const result = context.execute("aws", [
    "ecs",
    "describe-tasks",
    "--cluster",
    runbook.imports.cluster_arn,
    "--tasks",
    taskArn,
    "--region",
    REGION,
    "--output",
    "json",
    "--profile",
    "default",
  ]);
  if (result.status !== 0) throw new Error("could not describe the exact import task");
  const payload = parseJsonObject(result.stdout, "aws ecs describe-tasks");
  if (
    !Array.isArray(payload.failures) ||
    payload.failures.length !== 0 ||
    !Array.isArray(payload.tasks) ||
    payload.tasks.length !== 1
  ) {
    throw new Error("ECS did not return exactly one import task");
  }
  return payload.tasks[0];
}

function assertExactCanaryTask(task, runbook, importId, taskArn) {
  if (
    task?.taskArn !== taskArn ||
    task?.clusterArn !== runbook.imports.cluster_arn ||
    task?.taskDefinitionArn !== runbook.imports.task_definition_arn
  ) {
    throw new Error("the persisted import task ARN diverged from ECS");
  }
  const overrides = task?.overrides?.containerOverrides;
  if (!Array.isArray(overrides) || overrides.length !== 1) {
    throw new Error("the import task has divergent container overrides");
  }
  const container = overrides[0];
  if (
    container?.name !== runbook.imports.container_name ||
    !Array.isArray(container.command) ||
    container.command.length !== 3 ||
    container.command[0] !== "import-dump" ||
    container.command[1] !== "--import-id" ||
    container.command[2] !== importId
  ) {
    throw new Error("the import task override has a divergent import identity");
  }
  const environment = Array.isArray(container.environment) ? container.environment : [];
  const importIdentities = environment.filter((entry) => entry?.name === "IMPORT_ID");
  if (importIdentities.length !== 1 || importIdentities[0]?.value !== importId) {
    throw new Error("the import task IMPORT_ID override diverged");
  }
  const pipelines = environment.filter((entry) => entry?.name === "IMPORT_PIPELINE_VERSION");
  if (pipelines.length !== 1 || pipelines[0]?.value !== "canonical-v2") {
    throw new Error("the import task is not pinned to canonical-v2");
  }
}

function validateFaultControlItems(importItem, runItem, importId, stage) {
  const runId = `run_import_${importId.slice(4)}`;
  if (
    dynamoString(importItem, "pk") !== "IMPORTS" ||
    dynamoString(importItem, "sk") !== `IMPORT#${importId}` ||
    dynamoString(importItem, "importId") !== importId ||
    dynamoString(importItem, "state") !== "PROCESSING" ||
    dynamoString(importItem, "progressRunStage") !== stage ||
    dynamoString(importItem, "pipelineVersion") !== "canonical-v2" ||
    dynamoString(runItem, "pk") !== `INGESTION#RUN#${runId}` ||
    dynamoString(runItem, "sk") !== "META" ||
    dynamoString(runItem, "runId") !== runId ||
    dynamoString(runItem, "stage") !== stage
  ) {
    throw new Error("the import or run identity diverged before fault injection");
  }
}

function canaryEvidence(configuration, inspection, snapshot, metrics) {
  if (
    !IMPORT_CANARY_ID.test(snapshot?.importId ?? "") ||
    !["READY", "FAILED"].includes(snapshot?.state)
  ) {
    throw new Error("import-canary terminal identity is invalid");
  }
  const progress = validateCanaryProgress(snapshot.progress, "terminal import");
  const datasetVersion = snapshot.candidateVersion;
  if (
    (snapshot.state === "READY" &&
      !IMPORT_CANARY_DATASET_VERSION.test(datasetVersion ?? "")) ||
    (snapshot.state === "FAILED" && datasetVersion !== null)
  ) {
    throw new Error("import-canary terminal candidate identity is invalid");
  }
  const durationSeconds = metrics.durationSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error("import-canary duration is invalid");
  }
  if (typeof metrics.faultInjected !== "boolean") {
    throw new Error("import-canary fault flag is invalid");
  }
  const resumedParts = canaryNonNegativeInteger(
    metrics.resumedParts,
    "resumedParts",
  );
  const uploadedParts = canaryNonNegativeInteger(
    metrics.uploadedParts,
    "uploadedParts",
  );
  const observedInput = canaryObject(metrics.observedStages, "observedStages");
  const observedStages = {};
  for (const [stage, elapsed] of Object.entries(observedInput)) {
    if (
      !IMPORT_CANARY_OBSERVED_STAGES.has(stage) ||
      !Number.isFinite(elapsed) ||
      elapsed < 0
    ) {
      throw new Error("observedStages contains an invalid stage or duration");
    }
    observedStages[stage] = elapsed;
  }
  const completedAt = canaryTimestamp(metrics.completedAt, "completedAt");
  const recordsRead =
    progress.kind === "stage"
      ? canaryNonNegativeInteger(progress.recordsRead, "recordsRead")
      : 0;
  const recordsWritten =
    progress.kind === "stage"
      ? canaryNonNegativeInteger(progress.recordsWritten, "recordsWritten")
      : 0;
  const recordsRejected =
    progress.kind === "stage"
      ? canaryNonNegativeInteger(progress.recordsRejected, "recordsRejected")
      : 0;
  const candidateActivated =
    snapshot.state === "READY" && metrics.activeDataset === datasetVersion;
  if (candidateActivated) {
    throw new Error("import-canary candidate is already the active dataset");
  }
  const snapshotSizeBytes = canaryPositiveInteger(
    inspection.sizeBytes,
    "snapshotSizeBytes",
  );
  const rowsPerSecond =
    durationSeconds > 0 ? recordsRead / durationSeconds : null;
  if (rowsPerSecond !== null && !Number.isFinite(rowsPerSecond)) {
    throw new Error("import-canary rowsPerSecond is invalid");
  }
  return {
    schemaVersion: 1,
    label: configuration.label,
    importId: snapshot.importId,
    runId: `run_import_${snapshot.importId.slice(4)}`,
    datasetVersion,
    snapshotSha256: inspection.sha256,
    snapshotSizeBytes,
    extractedOn: configuration.extractedOn,
    state: snapshot.state,
    faultInjected: metrics.faultInjected,
    stopAtStage: configuration.stopAtStage,
    candidateVersion: datasetVersion,
    candidateActivated,
    partSizeBytes: IMPORT_CANARY_PART_SIZE,
    partCount: canaryPositiveInteger(inspection.parts.length, "partCount"),
    resumedParts,
    uploadedParts,
    durationSeconds,
    recordsRead,
    recordsWritten,
    recordsRejected,
    rowsPerSecond,
    observedStages,
    completedAt,
  };
}

function canaryDirectoryIdentity(metadata) {
  if (
    !metadata?.isDirectory?.() ||
    !Number.isInteger(metadata.dev) ||
    !Number.isInteger(metadata.ino) ||
    !Number.isInteger(metadata.nlink) ||
    metadata.nlink < 1 ||
    !Number.isInteger(metadata.uid) ||
    !Number.isInteger(metadata.mode)
  ) {
    throw new Error("the canary evidence directory identity is unavailable");
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
    owner: metadata.uid,
    mode: metadata.mode & 0o7777,
  };
}

function canaryDirectoryIdentityMatches(metadata, expected) {
  if (!metadata?.isDirectory?.()) return false;
  const current = canaryDirectoryIdentity(metadata);
  return (
    current.device === expected.device &&
    current.inode === expected.inode &&
    current.links === expected.links &&
    current.owner === expected.owner &&
    current.mode === expected.mode
  );
}

function closeCanaryDirectoryChain(chain) {
  let closeError = null;
  for (const entry of [...chain].reverse()) {
    try {
      closeSync(entry.descriptor);
    } catch (error) {
      closeError ??= error;
    }
  }
  if (closeError !== null) throw closeError;
}

function validateCanaryDirectoryChain(directory) {
  const { chain, rootPath, userId } = directory;
  let rootMetadata;
  try {
    rootMetadata = lstatSync(rootPath);
    if (realpathSync(rootPath) !== rootPath) {
      throw new Error("the canary evidence root path is no longer physical");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("the canary"))
      throw error;
    throw new Error("the canary evidence root path could not be revalidated");
  }
  if (!canaryDirectoryIdentityMatches(rootMetadata, chain[0].identity)) {
    throw new Error("the canary evidence root directory changed identity");
  }
  for (const [index, entry] of chain.entries()) {
    const metadata = fstatSync(entry.descriptor);
    if (
      !canaryDirectoryIdentityMatches(metadata, entry.identity) ||
      metadata.uid !== userId ||
      (index > 0 && (metadata.mode & 0o7777) !== 0o700)
    ) {
      throw new Error("the canary evidence directory chain changed identity");
    }
    if (index === 0) continue;
    const parent = chain[index - 1];
    let linkedDescriptor = null;
    try {
      linkedDescriptor = openSync(
        `/proc/self/fd/${parent.descriptor}/${entry.name}`,
        fsConstants.O_RDONLY |
          fsConstants.O_DIRECTORY |
          fsConstants.O_NOFOLLOW |
          (fsConstants.O_CLOEXEC ?? 0),
      );
      if (
        !canaryDirectoryIdentityMatches(
          fstatSync(linkedDescriptor),
          entry.identity,
        )
      ) {
        throw new Error(
          "the canary evidence parent now links to a different directory",
        );
      }
    } finally {
      if (Number.isInteger(linkedDescriptor)) closeSync(linkedDescriptor);
    }
  }
}

function validateCanaryEvidencePlatform(platform) {
  if (
    platform !== "linux" ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_DIRECTORY)
  ) {
    throw new Error(
      "secure import-canary evidence requires Linux descriptor safeguards",
    );
  }
  let procDescriptor = null;
  try {
    procDescriptor = openSync(
      "/proc/self/fd",
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        (fsConstants.O_CLOEXEC ?? 0),
    );
    if (!fstatSync(procDescriptor).isDirectory())
      throw new Error("not a directory");
  } catch {
    throw new Error(
      "secure import-canary evidence requires an available /proc/self/fd",
    );
  } finally {
    if (Number.isInteger(procDescriptor)) closeSync(procDescriptor);
  }
}

function canaryEvidenceDirectory(context, target) {
  validateCanaryEvidencePlatform(context.platform);
  const rootPath = path.resolve(context.root);
  const expected = path.join(rootPath, ".artifacts", "argus-import-canary");
  if (target !== expected)
    throw new Error("refusing an unexpected canary evidence directory");
  const userId = context.currentUserId();
  if (!Number.isInteger(userId))
    throw new Error("canary evidence owner is unavailable");
  const chain = [];
  try {
    const rootEntry = lstatSync(rootPath);
    if (
      rootEntry.isSymbolicLink() ||
      !rootEntry.isDirectory() ||
      rootEntry.uid !== userId ||
      realpathSync(rootPath) !== rootPath
    ) {
      throw new Error("the canary evidence root is not owned and physical");
    }
    const rootDescriptor = openSync(
      rootPath,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_CLOEXEC ?? 0),
    );
    chain.push({ descriptor: rootDescriptor, name: null, identity: null });
    if (
      !identityMatches(fstatSync(rootDescriptor), artifactIdentity(rootEntry))
    ) {
      throw new Error("the canary evidence root changed while it was opened");
    }
    for (const name of [".artifacts", "argus-import-canary"]) {
      const parent = chain.at(-1);
      const anchoredPath = `/proc/self/fd/${parent.descriptor}/${name}`;
      try {
        mkdirSync(anchoredPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw new Error("the canary evidence directory could not be created");
        }
      }
      const descriptor = openSync(
        anchoredPath,
        fsConstants.O_RDONLY |
          fsConstants.O_DIRECTORY |
          fsConstants.O_NOFOLLOW |
          (fsConstants.O_CLOEXEC ?? 0),
      );
      chain.push({ descriptor, name, identity: null });
      const metadata = fstatSync(descriptor);
      if (!metadata.isDirectory() || metadata.uid !== userId) {
        throw new Error(
          "the canary evidence directory is not owned and physical",
        );
      }
      fchmodSync(descriptor, 0o700);
    }
    for (const [index, entry] of chain.entries()) {
      const identity = canaryDirectoryIdentity(fstatSync(entry.descriptor));
      if (identity.owner !== userId || (index > 0 && identity.mode !== 0o700)) {
        throw new Error("the canary evidence directory is not private");
      }
      entry.identity = identity;
    }
    const directory = {
      path: expected,
      rootPath,
      userId,
      chain,
      descriptor: chain.at(-1).descriptor,
    };
    validateCanaryDirectoryChain(directory);
    return directory;
  } catch (error) {
    try {
      closeCanaryDirectoryChain(chain);
    } catch (closeError) {
      if (error instanceof Error) error.closeCause = closeError;
    }
    throw error;
  }
}

function writeCanaryEvidenceAtomically(context, configuration, contents) {
  const expectedDirectory = path.join(
    path.resolve(context.root),
    ".artifacts",
    "argus-import-canary",
  );
  if (
    configuration.artifactDirectory !== expectedDirectory ||
    path.dirname(configuration.evidence) !== expectedDirectory ||
    path.basename(configuration.evidence) !==
      `import-canary-${configuration.label}.json`
  ) {
    throw new Error("refusing an unexpected canary evidence path");
  }
  const directory = canaryEvidenceDirectory(
    context,
    configuration.artifactDirectory,
  );
  let temporaryDescriptor = null;
  let finalDescriptor = null;
  let temporaryPath = null;
  let operationError = null;
  let publishedOwnFile = false;
  try {
    const temporaryName = `.${path.basename(configuration.evidence)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
    temporaryPath = `/proc/self/fd/${directory.descriptor}/${temporaryName}`;
    const finalPath = `/proc/self/fd/${directory.descriptor}/${path.basename(configuration.evidence)}`;
    temporaryDescriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_CLOEXEC ?? 0),
      0o600,
    );
    const temporaryMetadata = fstatSync(temporaryDescriptor);
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.uid !== directory.userId ||
      temporaryMetadata.nlink !== 1
    ) {
      throw new Error("the canary evidence temporary file is not private");
    }
    const temporaryIdentity = artifactIdentity(temporaryMetadata);
    fchmodSync(temporaryDescriptor, 0o600);
    context.writeFile(temporaryDescriptor, contents, { encoding: "utf8" });
    fsyncSync(temporaryDescriptor);
    const writtenMetadata = fstatSync(temporaryDescriptor);
    if (
      !identityMatches(writtenMetadata, temporaryIdentity) ||
      writtenMetadata.nlink !== 1 ||
      (writtenMetadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "the canary evidence temporary file changed while writing",
      );
    }
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;
    validateCanaryDirectoryChain(directory);
    renameSync(temporaryPath, finalPath);
    temporaryPath = null;
    fsyncSync(directory.descriptor);
    finalDescriptor = openSync(
      finalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const finalMetadata = fstatSync(finalDescriptor);
    if (
      !finalMetadata.isFile() ||
      finalMetadata.uid !== directory.userId ||
      finalMetadata.nlink !== 1 ||
      (finalMetadata.mode & 0o777) !== 0o600 ||
      !identityMatches(finalMetadata, temporaryIdentity)
    ) {
      throw new Error(
        "the published canary evidence is not the private temporary file",
      );
    }
    publishedOwnFile = true;
    validateCanaryDirectoryChain(directory);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError = null;
    for (const descriptor of [finalDescriptor, temporaryDescriptor]) {
      if (!Number.isInteger(descriptor)) continue;
      try {
        closeSync(descriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (temporaryPath !== null) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupError ??= error;
      }
    }
    if (operationError !== null && publishedOwnFile) {
      try {
        unlinkSync(
          `/proc/self/fd/${directory.descriptor}/${path.basename(configuration.evidence)}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupError ??= error;
      }
    }
    try {
      closeCanaryDirectoryChain(directory.chain);
    } catch (error) {
      cleanupError ??= error;
    }
    if (operationError === null && cleanupError !== null) throw cleanupError;
  }
}

function persistCanaryEvidence(context, configuration, evidence) {
  context.writeCanaryEvidence(
    context,
    configuration,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

async function injectCanaryFault(
  context,
  configuration,
  runbook,
  importId,
  stage,
  deadline,
  initialActiveDataset,
) {
  const tableName = runbook.data.operational_table;
  const runId = `run_import_${importId.slice(4)}`;
  const importItem = awsOperationalItem(
    context,
    tableName,
    { pk: { S: "IMPORTS" }, sk: { S: `IMPORT#${importId}` } },
    "import control item",
  );
  const runItem = awsOperationalItem(
    context,
    tableName,
    { pk: { S: `INGESTION#RUN#${runId}` }, sk: { S: "META" } },
    "import run item",
  );
  validateFaultControlItems(importItem, runItem, importId, stage);
  const taskArn = dynamoString(importItem, "taskArn");
  if (taskArn === null) throw new Error("the import has no persisted task ARN");

  const task = describeExactCanaryTask(context, runbook, taskArn);
  assertExactCanaryTask(task, runbook, importId, taskArn);
  if (task.lastStatus === "STOPPED") throw new Error("the exact import task already stopped");

  const phrase = `STOP ${context.identity.account} ${importId} ${taskArn}`;
  if (!(await context.confirm(phrase))) throw new Error("fault injection confirmation was rejected");
  if (context.monotonic() >= deadline) {
    throw new Error("deadline expired after fault injection confirmation");
  }
  const confirmedImportItem = awsOperationalItem(
    context,
    tableName,
    { pk: { S: "IMPORTS" }, sk: { S: `IMPORT#${importId}` } },
    "confirmed import control item",
  );
  const confirmedRunItem = awsOperationalItem(
    context,
    tableName,
    { pk: { S: `INGESTION#RUN#${runId}` }, sk: { S: "META" } },
    "confirmed import run item",
  );
  validateFaultControlItems(confirmedImportItem, confirmedRunItem, importId, stage);
  const confirmedTaskArn = dynamoString(confirmedImportItem, "taskArn");
  if (confirmedTaskArn !== taskArn) {
    throw new Error("the persisted import task changed after confirmation");
  }
  const confirmedTask = describeExactCanaryTask(context, runbook, taskArn);
  assertExactCanaryTask(confirmedTask, runbook, importId, taskArn);
  if (confirmedTask.lastStatus === "STOPPED") {
    throw new Error("the exact import task stopped after confirmation");
  }
  if (context.monotonic() >= deadline) {
    throw new Error("deadline expired during post-confirmation evidence validation");
  }
  const stopped = context.execute("aws", [
    "ecs",
    "stop-task",
    "--cluster",
    runbook.imports.cluster_arn,
    "--task",
    taskArn,
    "--reason",
    `import-canary ${configuration.label} ${stage}`,
    "--region",
    REGION,
    "--output",
    "json",
    "--profile",
    "default",
  ]);
  if (stopped.status !== 0) throw new Error("could not stop the exact import task");
  if (parseJsonObject(stopped.stdout, "aws ecs stop-task").task?.taskArn !== taskArn) {
    throw new Error("ECS stopped a divergent task");
  }

  while (true) {
    const current = describeExactCanaryTask(context, runbook, taskArn);
    assertExactCanaryTask(current, runbook, importId, taskArn);
    if (current.lastStatus === "STOPPED") {
      const container = Array.isArray(current.containers)
        ? current.containers.find((entry) => entry?.name === runbook.imports.container_name)
        : undefined;
      if (
        container?.lastStatus !== "STOPPED" ||
        !Number.isInteger(container.exitCode) ||
        container.exitCode === 0
      ) {
        throw new Error("fault-injected ingestion container did not stop non-zero");
      }
      break;
    }
    if (context.monotonic() >= deadline) {
      throw new Error("deadline expired while waiting for the exact stopped task");
    }
    await context.sleep(IMPORT_CANARY_POLL_MILLISECONDS);
  }

  while (true) {
    const currentImport = awsOperationalItem(
      context,
      tableName,
      { pk: { S: "IMPORTS" }, sk: { S: `IMPORT#${importId}` } },
      "faulted import control item",
    );
    if (
      dynamoString(currentImport, "importId") !== importId ||
      dynamoString(currentImport, "taskArn") !== taskArn
    ) {
      throw new Error("the faulted import identity diverged");
    }
    const error = currentImport?.error?.M;
    const failed =
      dynamoString(currentImport, "state") === "FAILED" &&
      dynamoBoolean(error, "retryable") === true;
    const lock = awsOperationalItem(
      context,
      tableName,
      { pk: { S: "CONTROL#IMPORT" }, sk: { S: "ACTIVE" } },
      "active import lock",
    );
    if (lock !== null && dynamoString(lock, "importId") !== importId) {
      throw new Error("the active import lock belongs to a divergent import");
    }
    if (failed && lock === null) {
      const activeDataset = readActiveDatasetVersion(context, tableName);
      if (activeDataset !== initialActiveDataset) {
        throw new Error("fault injection changed the active candidate");
      }
      if (currentImport?.candidateVersion && currentImport.candidateVersion.NULL !== true) {
        throw new Error("fault injection left a candidate active");
      }
      return {
        importId,
        state: "FAILED",
        candidateVersion: null,
        progress: {
          kind: "stage",
          stage,
          recordsRead: 0,
          recordsWritten: 0,
          recordsRejected: 0,
        },
      };
    }
    if (context.monotonic() >= deadline) {
      throw new Error("deadline expired before retryable FAILED and lock release");
    }
    await context.sleep(IMPORT_CANARY_POLL_MILLISECONDS);
  }
}

async function importCanary(context) {
  const { configuration, runbook } = context;
  const panelOutput = context.execute("terraform", [
    `-chdir=${path.join("apps", "fullstack")}`,
    "output",
    "-json",
    "painel_url",
  ], { cwd: context.root });
  if (panelOutput.status !== 0) throw new Error("terraform output painel_url failed");
  let panelUrl;
  try {
    panelUrl = new URL(JSON.parse(panelOutput.stdout));
  } catch {
    throw new Error("terraform output painel_url is invalid");
  }
  if (
    panelUrl.protocol !== "https:" ||
    panelUrl.username ||
    panelUrl.password ||
    panelUrl.pathname !== "/" ||
    panelUrl.search ||
    panelUrl.hash ||
    runbook.imports.cors_origin !== panelUrl.origin
  ) {
    throw new Error("painel_url diverges from the validated same-origin import configuration");
  }
  if (
    typeof runbook.storage?.bucket !== "string" ||
    runbook.storage.bucket.length === 0 ||
    typeof runbook.imports.cluster_arn !== "string" ||
    typeof runbook.imports.task_definition_arn !== "string" ||
    typeof runbook.imports.container_name !== "string"
  ) {
    throw new Error("the validated import runbook is incomplete");
  }

  const started = context.monotonic();
  const deadline = started + configuration.timeoutSeconds;
  const inspection = configuration.inspection;

  const initialActiveDataset = readActiveDatasetVersion(
    context,
    runbook.data.operational_table,
  );
  let password = await context.readSecret("Password: ");
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("import-canary password cannot be empty");
  }
  const loginResponse = await context.httpRequest(new URL("/auth/login", panelUrl), {
    method: "POST",
    headers: canaryApiHeaders(null, {
      "Content-Type": "application/json",
      Origin: panelUrl.origin,
    }),
    body: JSON.stringify({ username: configuration.username, password }),
    redirect: "error",
  });
  password = null;
  await parseHttpJson(loginResponse, "same-origin login");
  const rawCookie = loginResponse.headers?.get?.("set-cookie");
  const session = typeof rawCookie === "string" ? /(?:^|,\s*)session=([^;,\s]+)/.exec(rawCookie) : null;
  if (!session) throw new Error("same-origin login did not issue a session cookie");
  let cookie = `session=${session[1]}`;

  try {
    const startPayload = await canaryApiJson(
      context,
      new URL("/api/v1/imports", panelUrl),
      {
        method: "POST",
        headers: canaryApiHeaders(cookie, {
          "Content-Type": "application/json",
          "Idempotency-Key": stableCanaryIdempotencyKey(
            configuration,
            inspection,
            "start",
          ),
          Origin: panelUrl.origin,
        }),
        body: JSON.stringify({
          fileName: "argus_dump.sql.gz",
          sizeBytes: inspection.sizeBytes,
          snapshotExtractedOn: configuration.extractedOn,
        }),
      },
      "start import",
    );
    if (!IMPORT_CANARY_ID.test(startPayload.importId ?? "")) {
      throw new Error("start import returned an invalid import ID");
    }
    const importId = startPayload.importId;
    const start = validateCanarySnapshot(
      startPayload,
      importId,
      "start import",
      configuration,
      inspection,
    );

    let resumedParts = 0;
    let uploadedParts = 0;
    let snapshot = start;
    if (start.state === "UPLOADING") {
      const listed = await canaryApiJson(
        context,
        new URL(`/api/v1/imports/${importId}/parts`, panelUrl),
        {
          method: "GET",
          headers: canaryApiHeaders(cookie, { Origin: panelUrl.origin }),
        },
        "list import parts",
      );
      if (!Array.isArray(listed.parts)) throw new Error("list import parts returned no parts");
      resumedParts = listed.parts.length;
      const completed = new Map();
      for (const remote of listed.parts) {
        const local = inspection.parts[remote?.partNumber - 1];
        if (
          local === undefined ||
          completed.has(remote.partNumber) ||
          remote.checksumSha256 !== local.checksumSha256 ||
          remote.sizeBytes !== local.sizeBytes ||
          typeof remote.etag !== "string" ||
          remote.etag.length === 0
        ) {
          throw new Error("list import parts returned divergent upload evidence");
        }
        completed.set(remote.partNumber, {
          partNumber: remote.partNumber,
          etag: remote.etag,
          checksumSha256: remote.checksumSha256,
        });
      }

      const missing = inspection.parts.filter((part) => !completed.has(part.partNumber));
      uploadedParts = missing.length;
      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20);
        const signed = await canaryApiJson(
          context,
          new URL(`/api/v1/imports/${importId}/parts`, panelUrl),
          {
            method: "POST",
            headers: canaryApiHeaders(cookie, {
              "Content-Type": "application/json",
              Origin: panelUrl.origin,
            }),
            body: JSON.stringify({
              parts: batch.map(({ partNumber, checksumSha256 }) => ({
                partNumber,
                checksumSha256,
              })),
            }),
          },
          "sign import parts",
        );
        if (!Array.isArray(signed.parts) || signed.parts.length !== batch.length) {
          throw new Error("sign import parts returned divergent evidence");
        }
        const uploads = signed.parts.map((entry) => {
          const local = batch.find((part) => part.partNumber === entry?.partNumber);
          const signedUrl = validateCanarySignedUploadUrl(entry?.url, runbook.storage.bucket);
          const checksumHeader = Object.entries(entry?.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "x-amz-checksum-sha256",
          );
          if (local === undefined || checksumHeader?.[1] !== local.checksumSha256) {
            throw new Error("sign import parts returned divergent part identity");
          }
          return { local, url: signedUrl, headers: entry.headers };
        });
        await runWithConcurrency(uploads, IMPORT_CANARY_UPLOAD_CONCURRENCY, async (upload) => {
          const body = context.readSnapshotPart(inspection, upload.local);
          const response = await context.httpRequest(upload.url, {
            method: "PUT",
            headers: { ...upload.headers },
            body,
            redirect: "error",
          });
          if (!response?.ok) throw new Error(`multipart upload failed with HTTP ${response?.status}`);
          const etag = response.headers?.get?.("etag");
          if (typeof etag !== "string" || etag.length === 0) {
            throw new Error("multipart upload returned no ETag");
          }
          completed.set(upload.local.partNumber, {
            partNumber: upload.local.partNumber,
            etag,
            checksumSha256: upload.local.checksumSha256,
          });
        });
      }
      if (completed.size !== inspection.parts.length) {
        throw new Error("multipart upload did not confirm every part");
      }
      const manifest = [...completed.values()].sort((left, right) => left.partNumber - right.partNumber);
      const complete = await canaryApiJson(
        context,
        new URL(`/api/v1/imports/${importId}/complete`, panelUrl),
        {
          method: "POST",
          headers: canaryApiHeaders(cookie, {
            "Content-Type": "application/json",
            "Idempotency-Key": stableCanaryIdempotencyKey(configuration, inspection, "complete"),
            Origin: panelUrl.origin,
          }),
          body: JSON.stringify({ parts: manifest }),
        },
        "complete import",
      );
      snapshot = validateCanarySnapshot(complete, importId, "complete import", configuration, inspection);
    }
    const observed = new Map();
    while (true) {
      const elapsed = context.monotonic() - started;
      const stage = snapshot.progress?.kind === "stage" ? snapshot.progress.stage : snapshot.state;
      if (typeof stage === "string" && !observed.has(stage)) observed.set(stage, elapsed);

      let terminal = snapshot;
      let faultInjected = false;
      if (
        configuration.stopAtStage !== null &&
        snapshot.state === "PROCESSING" &&
        stage === configuration.stopAtStage
      ) {
        terminal = await injectCanaryFault(
          context,
          configuration,
          runbook,
          importId,
          stage,
          deadline,
          initialActiveDataset,
        );
        faultInjected = true;
      } else if (snapshot.state === "FAILED") {
        throw new Error(`import ${importId} reached FAILED`);
      } else if (snapshot.state !== "READY") {
        if (context.monotonic() >= deadline) {
          throw new Error(`import ${importId} exceeded its deadline without stopping the task`);
        }
        await context.sleep(IMPORT_CANARY_POLL_MILLISECONDS);
        snapshot = validateCanarySnapshot(
          await canaryApiJson(
            context,
            new URL(`/api/v1/imports/${importId}`, panelUrl),
            {
              method: "GET",
              headers: canaryApiHeaders(cookie, { Origin: panelUrl.origin }),
            },
            "get import",
          ),
          importId,
          "get import",
          configuration,
          inspection,
        );
        continue;
      }

      const activeDataset = readActiveDatasetVersion(context, runbook.data.operational_table);
      if (activeDataset !== initialActiveDataset) {
        throw new Error("import-canary changed the active dataset");
      }
      const durationSeconds = context.monotonic() - started;
      const evidence = canaryEvidence(configuration, inspection, terminal, {
        faultInjected,
        resumedParts,
        uploadedParts,
        durationSeconds,
        observedStages: Object.fromEntries(observed),
        completedAt: context.now().toISOString(),
        activeDataset,
      });
      persistCanaryEvidence(context, configuration, evidence);
      context.log(`import ${importId}: ${terminal.state} (candidate not activated)`);
      return {
        importId,
        state: terminal.state,
        faultInjected,
        evidence: configuration.evidence,
      };
    }
  } finally {
    cookie = null;
  }
}

async function seed(context) {
  const {
    execute,
    log,
    root,
    venv,
    identity,
    writeFile,
    makeDirectory,
    now,
    monotonic,
    sleep,
    seedConfiguration,
  } = context;
  const stack = path.join("apps", "fullstack");
  const service = path.join(root, "apps", "backend", "ingestion-data");
  const { snapshot, extractedOn, label, timeoutSeconds, terraformOutput, evidence } =
    seedConfiguration;
  if (seedConfiguration.custom) {
    makeDirectory(seedConfiguration.artifactDirectory, { recursive: true, mode: 0o700 });
  }

  // Task-definition ARNs change on each apply. Reading the output here prevents
  // operators from accidentally launching a stale revision.
  assertDefaultWorkspace(context);
  log("Reading the newly created resource identifiers");
  const output = execute(
    "terraform",
    [`-chdir=${stack}`, "output", "-json", "ingestion_runbook"],
    { cwd: root },
  );
  if (output.status !== 0) throw new Error(`terraform output failed: ${output.stderr}`);
  const runbook = JSON.parse(output.stdout);
  const bucket = runbook?.storage?.bucket;
  const cluster = runbook?.runtime?.cluster_arn;
  const operationalTable = runbook?.data?.operational_table ?? `${NAMESPACE}-operacional`;
  if (typeof bucket !== "string" || !bucket || typeof cluster !== "string" || !cluster) {
    throw new Error("terraform output did not provide the ingestion bucket and cluster");
  }
  writeFile(terraformOutput, output.stdout, { encoding: "utf-8", mode: 0o600 });
  restrictPermissions(context, terraformOutput, 0o600);
  const account = identity?.account;
  if (typeof account !== "string") throw new Error("the Learner Lab account was not validated");

  log(`Uploading the snapshot to ${bucket}`);
  const uploaded = execute(venv, [
    path.join(service, "scripts", "upload_snapshot.py"),
    snapshot,
    "--bucket",
    bucket,
    "--account-id",
    account,
    "--region",
    REGION,
    "--snapshot-extracted-on",
    extractedOn,
    "--output",
    evidence,
  ]);
  if (uploaded.status !== 0) throw new Error(`snapshot upload failed: ${uploaded.stderr}`);
  restrictPermissions(context, evidence, 0o600);

  const attempt = `${label}-${now().toISOString().replaceAll(/[:.]/g, "-")}`;
  log(`Launching the non-activating backfill (attempt ${attempt})`);
  const launched = execute(venv, [
    path.join(service, "scripts", "run_task.py"),
    "--terraform-output",
    terraformOutput,
    "--snapshot",
    evidence,
    "--launch-attempt",
    attempt,
    "--no-activate",
  ]);
  if (launched.status !== 0) throw new Error(`could not launch the backfill: ${launched.stderr}`);
  const launch = parseJsonObject(launched.stdout, "run_task.py");
  const taskArn = launch.taskArn;
  const runId = launch.runId;
  if (
    typeof taskArn !== "string" ||
    !taskArn ||
    typeof runId !== "string" ||
    !runId ||
    launch.activated !== false
  ) {
    throw new Error("run_task.py did not confirm the task, run and non-activating mode");
  }
  log(`Task launched: ${taskArn}`);

  log("Polling the ECS task until it stops");
  const deadline = monotonic() + timeoutSeconds;
  let task;
  while (true) {
    const described = execute("aws", [
      "ecs",
      "describe-tasks",
      "--cluster",
      cluster,
      "--tasks",
      taskArn,
      "--region",
      REGION,
      "--output",
      "json",
      "--profile",
      "default",
    ]);
    if (described.status !== 0) {
      throw new Error(`could not inspect the ECS task: ${described.stderr}`);
    }
    const description = parseJsonObject(described.stdout, "aws ecs describe-tasks");
    const tasks = description.tasks;
    if (
      !Array.isArray(tasks) ||
      tasks.length !== 1 ||
      tasks[0]?.taskArn !== taskArn ||
      typeof tasks[0]?.lastStatus !== "string" ||
      tasks[0].lastStatus.length === 0 ||
      !Array.isArray(description.failures) ||
      description.failures.length > 0
    ) {
      throw new Error("the ECS task response is invalid");
    }
    task = tasks[0];
    if (task.lastStatus === "STOPPED") break;
    const remainingMilliseconds = (deadline - monotonic()) * 1_000;
    if (remainingMilliseconds <= 0) {
      log(`Local wait timed out; task is still running: ${taskArn}`);
      log("Resume inspection with the evidence command; the ECS task was not stopped.");
      return { taskArn, runId, timedOut: true };
    }
    await sleep(Math.min(SEED_POLL_INTERVAL_MILLISECONDS, remainingMilliseconds));
  }
  const containers = task.containers;
  for (const name of ["ingestion", "mysql-snapshot"]) {
    const container = Array.isArray(containers)
      ? containers.find((item) => item?.name === name)
      : undefined;
    if (container?.lastStatus !== "STOPPED" || container?.exitCode !== 0) {
      throw new Error(`container ${name} stopped with a non-zero exit code`);
    }
  }

  const durableRun = execute("aws", [
    "dynamodb",
    "get-item",
    "--table-name",
    operationalTable,
    "--key",
    JSON.stringify({ pk: { S: `INGESTION#RUN#${runId}` }, sk: { S: "META" } }),
    "--consistent-read",
    "--region",
    REGION,
    "--output",
    "json",
    "--profile",
    "default",
  ]);
  if (durableRun.status !== 0) {
    throw new Error(`could not verify the durable run: ${durableRun.stderr}`);
  }
  const item = parseJsonObject(durableRun.stdout, "aws dynamodb get-item").Item;
  const stage = item?.stage?.S;
  if (item?.runId?.S !== runId || stage !== "SUCCEEDED") {
    throw new Error(`run ${runId} ended in ${String(stage ?? "missing state")}`);
  }
  log(`run ${runId}: SUCCEEDED (candidate not activated)`);
  return { taskArn, runId, timedOut: false };
}

function printEvidence({ execute, log }) {
  log("Runs recorded in the operational table:");
  const readResult = execute("aws", [
    "dynamodb",
    "scan",
    "--table-name",
    `${NAMESPACE}-operacional`,
    "--region",
    REGION,
    "--filter-expression",
    "begins_with(pk, :p) AND sk = :s",
    "--expression-attribute-values",
    '{":p":{"S":"INGESTION#RUN#"},":s":{"S":"META"}}',
    "--projection-expression",
    "pk,stage,recordsRead,recordsWritten,recordsRejected,errorCount",
    "--output",
    "json",
  ]);
  if (readResult.status !== 0) throw new Error(`could not read ingestion runs: ${readResult.stderr}`);
  log(readResult.stdout.trim());
}

async function readSecretFromTerminal(prompt) {
  if (stdin.isTTY !== true || stdout.isTTY !== true || typeof stdin.setRawMode !== "function") {
    throw new Error("a TTY is required to read the import-canary password");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let secret = "";
  return new Promise((resolve, reject) => {
    const finish = (error = null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error === null) resolve(secret);
      else reject(error);
    };
    const onData = (chunk) => {
      for (const character of Buffer.from(chunk).toString("utf8")) {
        if (character === "\u0003") {
          secret = "";
          finish(new Error("password prompt interrupted"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else if (character >= " " && secret.length < 1024) {
          secret += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readInputFromTerminal(prompt) {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

export async function runLearnerLab(options = {}) {
  const {
    step,
    preset,
    extraArguments = [],
    platform = process.platform,
    execute = executeCommand,
    log = (line) => process.stdout.write(`${line}\n`),
    exists = existsSync,
    accessFile = accessSync,
    makeDirectory = mkdirSync,
    writeFile = writeFileSync,
    changeMode = chmodSync,
    lstat = lstatSync,
    readFile = readFileSync,
    readPlanFile = readFileSync,
    readDirectory = readdirSync,
    makeTemporaryDirectory = mkdtempSync,
    inspectArtifactPath = lstatSync,
    openPlanFile = openSync,
    inspectPlanFile = fstatSync,
    closePlanFile = closeSync,
    openBackupPath = openSync,
    inspectBackupFile = fstatSync,
    readBackupFile = readFileSync,
    writeBackupFile = writeFileSync,
    closeBackupFile = closeSync,
    removeArtifactFile = unlinkSync,
    removeArtifactDirectory = rmdirSync,
    resolveArtifactPath = realpathSync,
    realpath = realpathSync,
    currentUserId = () => process.getuid?.(),
    now = () => new Date(),
    monotonic = () => performance.now() / 1_000,
    sleep = delay,
    confirm = async () => false,
    confirmDeploy = null,
    inspectSnapshot = inspectCanarySnapshot,
    readSnapshotPart = readCanarySnapshotPart,
    closeSnapshot = closeCanarySnapshot,
    writeCanaryEvidence = writeCanaryEvidenceAtomically,
    httpRequest = fetch,
    isTty = () => stdin.isTTY === true && stdout.isTTY === true,
    readInput = readInputFromTerminal,
    readSecret = readSecretFromTerminal,
    generateRandomBytes = randomBytes,
    makeSensitiveTemporaryDirectory = mkdtempSync,
    writeSensitiveFile = writeFileSync,
    removeSensitiveFile = unlinkSync,
    removeSensitiveDirectory = rmdirSync,
    environment = process.env,
    // The command lives under apps/scripts; resolve project paths from the repository root.
    root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  } = options;

  const hasPresetArgument = preset !== undefined && preset !== null && preset !== "";
  const hasExtraArguments = !Array.isArray(extraArguments) || extraArguments.length > 0;
  if (step === undefined || step === null || step === "" || HELP_COMMANDS.has(step)) {
    if (hasPresetArgument || hasExtraArguments) {
      log("help does not accept extra arguments");
      return { status: 2 };
    }
    log(HELP);
    return { status: 0 };
  }

  if (!COMMANDS.includes(step)) {
    log(`unknown command: ${step}. use one of: ${COMMANDS.join(", ")}`);
    return { status: 2 };
  }

  let seedConfiguration = null;
  let importCanaryConfiguration = null;
  let setupConfiguration = null;
  let initialUser = null;
  if (["plan-update", "update"].includes(step)) {
    if (!Object.hasOwn(UPDATE_PRESETS, preset) || hasExtraArguments) {
      log(`update requires one preset: ${Object.keys(UPDATE_PRESETS).join(", ")}`);
      return { status: 2 };
    }
  } else if (step === "setup") {
    if (hasPresetArgument) {
      log("setup options must be passed as named arguments");
      return { status: 2 };
    }
    try {
      setupConfiguration = parseSetupConfiguration(extraArguments, {
        root,
        lstat,
        accessFile,
        readFile,
      });
      const email = String(await readInput("Initial user email: ")).trim();
      const password = await readSecret("Initial user password: ");
      validateInitialUser(email, password);
      initialUser = { email, password };
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 2 };
    }
  } else if (step === "deploy") {
    if (hasPresetArgument) {
      log("deploy options must be passed as named arguments");
      return { status: 2 };
    }
    try {
      setupConfiguration = parseSetupConfiguration(
        extraArguments,
        { root, lstat, accessFile, readFile },
        { command: "deploy" },
      );
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 2 };
    }
  } else if (step === "seed") {
    if (hasPresetArgument) {
      log("seed options must be passed as named arguments");
      return { status: 2 };
    }
    try {
      seedConfiguration = parseSeedConfiguration({ extraArguments, root, lstat, accessFile });
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 2 };
    }
  } else if (step === "import-canary") {
    if (hasPresetArgument) {
      log("import-canary options must be passed as named arguments");
      return { status: 2 };
    }
    try {
      importCanaryConfiguration = parseImportCanaryConfiguration({
        extraArguments,
        root,
        lstat,
        accessFile,
        isTty,
      });
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 2 };
    }
  } else if (hasPresetArgument || hasExtraArguments) {
    log(`${step} does not accept extra arguments`);
    return { status: 2 };
  }

  if (PROTECTED_COMMANDS.has(step)) {
    try {
      assertProtectedUpdateEnvironment({ environment, root, lstat, realpath });
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 1 };
    }
  }

  if (
    ["setup", "check", "deploy", "destroy", "plan-update", "update", "seed", "import-canary", "all"].includes(
      step,
    )
  ) {
    try {
      assertCleanTerraformEnvironment(environment);
      if (["setup", "check", "deploy", "destroy", "plan-update", "update", "all"].includes(step)) {
        assertNoAutomaticVariableFiles({ readDirectory, root });
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return { status: 1 };
    }
  }

  const context = {
    execute,
    log,
    platform,
    root,
    exists,
    accessFile,
    makeDirectory,
    writeFile,
    changeMode,
    lstat,
    readFile,
    readPlanFile,
    readDirectory,
    makeTemporaryDirectory,
    inspectArtifactPath,
    openPlanFile,
    inspectPlanFile,
    closePlanFile,
    openBackupPath,
    inspectBackupFile,
    readBackupFile,
    writeBackupFile,
    closeBackupFile,
    removeArtifactFile,
    removeArtifactDirectory,
    resolveArtifactPath,
    realpath,
    currentUserId,
    now,
    monotonic,
    sleep,
    confirm,
    confirmDeploy: confirmDeploy ?? confirm,
    inspectSnapshot,
    readSnapshotPart,
    closeSnapshot,
    writeCanaryEvidence,
    httpRequest,
    isTty,
    readInput,
    readSecret,
    generateRandomBytes,
    makeSensitiveTemporaryDirectory,
    writeSensitiveFile,
    removeSensitiveFile,
    removeSensitiveDirectory,
    environment,
    profile: setupConfiguration?.profile ?? "default",
    autoApprove: setupConfiguration?.autoApprove ?? false,
    analysisWorker: setupConfiguration?.analysisWorker ?? null,
    step,
    preset,
    seedConfiguration,
    importCanaryConfiguration,
  };
  const shouldRun = (name) => step === "all" || step === name;
  let importCanaryInspection = null;

  try {
    if (step === "import-canary") {
      validateCanaryEvidencePlatform(platform);
      importCanaryInspection = inspectSnapshot(
        importCanaryConfiguration.snapshot,
      );
      validateCanaryInspection(importCanaryInspection);
      importCanaryConfiguration = {
        ...importCanaryConfiguration,
        inspection: importCanaryInspection,
      };
    }
    const checked = checkPrerequisites(context);
    if (!checked.ok) return { status: 1 };
    if (step === "setup") {
      const applied = await deploy({ ...context, identity: checked.identity });
      if (!applied) return { status: 1 };
      const outputs = readSetupOutputs(context);
      ensureInternalIngestionCredential(context, outputs.runbook);
      provisionInitialCognitoUser(context, outputs, initialUser.email, initialUser.password);
      printSetupOutputs(context, outputs);
      return { status: 0 };
    }
    if (step === "check") {
      initializeAndValidateExistingStack(context, checked.identity);
      return { status: 0 };
    }
    if (step === "destroy") {
      const destroyed = await destroy({ ...context, identity: checked.identity });
      return { status: destroyed ? 0 : 1 };
    }
    if (["plan-update", "update"].includes(step)) {
      const existingStack = initializeAndValidateExistingStack(context, checked.identity);
      const updated = await updateExistingStack(
        { ...context, identity: checked.identity },
        existingStack,
      );
      if (updated && step === "update") {
        ensureInternalIngestionCredential(context, readIngestionRunbook(context));
      }
      return { status: updated ? 0 : 1 };
    }
    if (step === "import-canary") {
      const existingStack = initializeAndValidateExistingStack(context, checked.identity);
      const result = await importCanary({
        ...context,
        identity: checked.identity,
        runbook: existingStack.runbook,
        configuration: importCanaryConfiguration,
      });
      return { status: 0, ...result };
    }

    const needsVenv = ["build-snapshot", "seed", "all"].includes(step);
    const venv = needsVenv
      ? ensureVenv({ ...context, python: checked.python })
      : venvPython(root, platform);
    let snapshot = path.join(root, "reduced-argus.sql.gz");
    if (shouldRun("build-snapshot")) snapshot = buildSnapshot({ ...context, venv });
    if (shouldRun("deploy")) {
      const applied = await deploy({ ...context, identity: checked.identity });
      if (!applied) return { status: 1 };
      ensureInternalIngestionCredential(context, readIngestionRunbook(context));
    }
    if (shouldRun("seed")) {
      const selectedSeedConfiguration =
        seedConfiguration ??
        parseSeedConfiguration({ extraArguments: [], root, lstat, accessFile });
      const seedResult = await seed({
        ...context,
        venv,
        snapshot:
          step === "all" ? snapshot : selectedSeedConfiguration.snapshot,
        seedConfiguration:
          step === "all"
            ? { ...selectedSeedConfiguration, snapshot }
            : selectedSeedConfiguration,
        identity: checked.identity,
      });
      if (step === "seed") return { status: 0, ...seedResult };
    }
    if (shouldRun("evidence")) printEvidence(context);
    return { status: 0 };
  } catch (error) {
    log("");
    log(error instanceof Error ? error.message : String(error));
    return { status: 1 };
  } finally {
    if (importCanaryInspection !== null) {
      try {
        closeSnapshot(importCanaryInspection);
      } catch {
        log("import-canary snapshot descriptor could not be closed");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const step = process.argv[2];
  const updateCommand = ["plan-update", "update"].includes(step);
  const { status } = await runLearnerLab({
    step,
    preset: updateCommand ? process.argv[3] : undefined,
    extraArguments: process.argv.slice(updateCommand ? 4 : 3),
    confirm: async (phrase) => {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await terminal.question(`Type "${phrase}" to continue: `);
        return isExactConfirmation(answer, phrase);
      } finally {
        terminal.close();
      }
    },
    confirmDeploy: async (summary) => {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await terminal.question(`${summary} (s/N): `);
        return ["s", "sim"].includes(answer.trim().toLowerCase());
      } finally {
        terminal.close();
      }
    },
  });
  process.exitCode = status;
}

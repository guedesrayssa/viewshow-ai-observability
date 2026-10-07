import { spawn } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, readFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HELP = `Kubernetes Learner Lab
Usage: node apps/scripts/aws-learner-lab.mjs <command>
  help | --help | -h
  check
  plan [--update]
  setup [--yes] [--update]
  deploy
  validate
  evidence
  destroy
Configure apps/fullstack/terraform.tfvars first. See apps/kubernetes/README.md.`;
const COMMANDS = new Set(["help", "check", "plan", "setup", "deploy", "validate", "evidence", "destroy"]);

export async function withCleanup(operation, cleanup) {
  let primary;
  try {
    return await operation();
  } catch (error) {
    primary = error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (primary) throw new AggregateError([primary, cleanupError], "operation and cleanup failed");
      throw cleanupError;
    }
  }
  throw primary;
}

export function parseLearnerLabArguments(argv) {
  const command = ["--help", "-h"].includes(argv[0]) ? "help" : argv[0] ?? "help";
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}`);
  const configuration = { command, yes: false, update: false };
  const seen = new Set();
  for (const flag of argv.slice(1)) {
    const permitted = (flag === "--yes" && command === "setup") ||
      (flag === "--update" && ["plan", "setup"].includes(command));
    if (!permitted) throw new Error(`${command} does not accept ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    seen.add(flag);
    configuration[flag.slice(2)] = true;
  }
  return configuration;
}

async function executeCommand(program, args, { signal, input, ...options } = {}) {
  signal?.throwIfAborted();
  return await new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(program, args, { ...options, detached, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failed = false;
    let size = 0;
    const terminate = (signalName) => {
      try {
        // A deploy child can run kubectl/Helm of its own; cancel the owned group.
        if (detached && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch { /* The child may already have closed. */ }
    };
    const abort = () => terminate(signal.reason?.signalName ?? "SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const capture = (target, chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 32 * 1024 * 1024) {
        failed = true;
        terminate("SIGTERM");
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; });
    child.on("close", (status) => {
      signal?.removeEventListener("abort", abort);
      // close follows exit and closure of the child's stdio descriptors.
      resolve({ status: failed ? 127 : status ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function readInputFromTerminal(prompt, { signal } = {}) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt, { signal });
  } finally {
    terminal.close();
  }
}

async function confirmFromTerminal(prompt, options) {
  return /^y(es)?$/i.test((await readInputFromTerminal(`${prompt} [y/N] `, options)).trim());
}

export async function readSecretFromTerminal(prompt, { signal, input = process.stdin, output = process.stdout } = {}) {
  signal?.throwIfAborted();
  if (!input.isTTY) throw new Error("Secret input requires an interactive terminal.");
  const wasRaw = input.isRaw;
  // Readline keeps editing and cancellation, while its output discards all echoes.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = createInterface({ input, output: muted, terminal: true });
  const controller = new AbortController();
  const interrupt = () => {
    const failure = new Error("Operation cancelled by SIGINT.");
    failure.status = 130;
    controller.abort(failure);
  };
  terminal.on("SIGINT", interrupt);
  try {
    output.write(prompt);
    return await terminal.question("", { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
  } catch {
    if (controller.signal.aborted) throw controller.signal.reason;
    signal?.throwIfAborted();
    throw new Error("Unable to read secret from terminal.");
  } finally {
    terminal.removeListener("SIGINT", interrupt);
    terminal.close();
    if (wasRaw) input.setRawMode(true);
    muted.end();
    output.write("\n");
  }
}

async function runCommand(context, program, args, { allowedStatuses = [0], description = `${program} ${args.join(" ")}`, ...options } = {}) {
  context.signal.throwIfAborted();
  let result;
  try {
    result = await context.execute(program, args, { cwd: context.root, env: context.environment, signal: context.signal, ...options });
  } catch {
    context.signal.throwIfAborted();
    // Executor diagnostics may echo stdin, including secrets from the plan.
    throw new Error(`${description} failed to execute.`);
  }
  context.signal.throwIfAborted();
  if (!allowedStatuses.includes(result.status)) throw new Error(`${description} failed (status ${result.status}).`);
  return result;
}

async function checkPrerequisites(context) {
  await runCommand(context, "terraform", ["version"]);
  const result = await runCommand(context, "aws", ["sts", "get-caller-identity", "--output", "json"]);
  let identity;
  try {
    identity = JSON.parse(result.stdout);
  } catch {
    throw new Error("Invalid AWS identity JSON.");
  }
  if (!identity || typeof identity.Account !== "string" || !/^\d{12}$/.test(identity.Account) ||
    typeof identity.Arn !== "string" || !/^arn:[^:]+:[^:]+:[^:]*:\d{12}:.+/.test(identity.Arn))
    throw new Error("Invalid AWS identity: expected a 12-digit account and ARN.");
  await runCommand(context, "kubectl", ["version", "--client"]);
  await runCommand(context, "helm", ["version"]);
  return identity;
}

async function createPlan(context, configuration) {
  const identity = await checkPrerequisites(context);
  const artifactDirectory = resolve(context.root, "apps/fullstack/.terraform-artifacts");
  let directory;
  try {
    context.makeDirectory(artifactDirectory, { recursive: true, mode: 0o700 });
    context.chmod(artifactDirectory, 0o700);
    directory = context.makeTemporaryDirectory(resolve(artifactDirectory, "plan-"));
    trackPrivateFiles(context, { directory, file: resolve(directory, "kubernetes.tfplan") }, "Terraform plan");
    context.chmod(directory, 0o700);
  } catch {
    throw new Error("Unable to create private Terraform plan files.");
  }
  const planFile = resolve(directory, "kubernetes.tfplan");
  const planPath = relative(resolve(context.root, "apps/fullstack"), planFile);
  await runCommand(context, "terraform", ["-chdir=apps/fullstack", "init", "-input=false"]);
  const workspace = await runCommand(context, "terraform", [
    "-chdir=apps/fullstack", "workspace", "show",
  ], { description: "terraform workspace show" });
  if (workspace.stdout.trim() !== "default")
    throw new Error("Plan requires the default Terraform workspace.");
  const plan = await runCommand(context, "terraform", [
    "-chdir=apps/fullstack", "plan", "-input=false", "-detailed-exitcode",
    `-out=${planPath}`,
  ], { allowedStatuses: [0, 2], description: "terraform plan" });
  try { context.chmod(planFile, 0o600); } catch {
    throw new Error("Unable to protect private Terraform plan files.");
  }
  const shown = await runCommand(context, "terraform", [
    "-chdir=apps/fullstack", "show", "-json", planPath,
  ], { description: "terraform show" });
  const gateArgs = [
    "apps/scripts/terraform/validate-kubernetes-plan.mjs",
    ...(configuration.update ? ["--update"] : []),
  ];
  // The plan JSON can contain secrets. Keep it in memory and pass it only via stdin.
  await runCommand(context, process.execPath, gateArgs, { input: shown.stdout });
  const plannedRunbook = readPlannedTarget(shown.stdout);
  return {
    status: 0, planPath, hasChanges: plan.status === 2, identity,
    ...(plannedRunbook ? { plannedRunbook } : {}),
  };
}

const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

function readPlannedTarget(planJSON) {
  let plan;
  try {
    plan = JSON.parse(planJSON);
  } catch {
    throw new Error("Invalid validated Terraform plan JSON.");
  }
  const value = plan?.output_changes?.kubernetes_runbook?.after ??
    plan?.planned_values?.outputs?.kubernetes_runbook?.value;
  const namespace = value?.namespace ?? plan?.variables?.deployment_namespace?.value;
  const region = value?.region ?? plan?.variables?.regiao?.value;
  // This mirrors names.tf, using the configuration captured in the gated plan.
  const clusterName = value?.cluster_name ??
    (matches(namespace, NAMESPACE) ? `${namespace}-iac-cluster` : undefined);
  if (!matches(clusterName, CLUSTER_NAME) || !matches(region, REGION)) return undefined;
  return { clusterName, region, ...(matches(namespace, NAMESPACE) ? { namespace } : {}) };
}

function validateRunbook(runbook) {
  if (!matches(runbook?.cluster_name, CLUSTER_NAME) || !matches(runbook?.region, REGION) ||
    !matches(runbook?.namespace, NAMESPACE) || !matches(runbook?.imports_namespace, NAMESPACE) ||
    !matches(runbook?.storage?.bucket, BUCKET) || !matches(runbook?.storage?.operational_table, TABLE))
    throw new Error("Invalid kubernetes_runbook: cluster, region, namespaces and storage are required.");
  return runbook;
}

async function readRunbook(context) {
  const result = await runCommand(context, "terraform", [
    "-chdir=apps/fullstack", "output", "-json", "kubernetes_runbook",
  ]);
  let runbook;
  try {
    runbook = JSON.parse(result.stdout);
  } catch {
    throw new Error("Invalid kubernetes_runbook JSON.");
  }
  return validateRunbook(runbook);
}

async function readDeploymentOutputs(context) {
  const runbook = await readRunbook(context);
  const outputs = { runbook };
  for (const name of ["painel_url", "api_url_https", "cognito_user_pool_id", "cognito_client_id"]) {
    const output = await runCommand(context, "terraform", ["-chdir=apps/fullstack", "output", "-raw", name]);
    outputs[name] = output.stdout.trim();
    if (!outputs[name]) throw new Error(`Missing Terraform output: ${name}.`);
  }
  return outputs;
}

async function configureClusterAccess(context, outputs) {
  const { runbook } = outputs;
  const access = {};
  try {
    access.directory = context.makeTemporaryDirectory(resolve(tmpdir(), "learner-lab-kubernetes-"));
    trackPrivateFiles(context, access, "Kubernetes access");
    context.chmod(access.directory, 0o700);
    access.file = resolve(access.directory, "kubeconfig");
    context.writeSensitiveFile(access.file, JSON.stringify({
      apiVersion: "v1", kind: "Config", clusters: [], contexts: [], users: [], "current-context": "",
    }), { mode: 0o600, flag: "wx" });
  } catch {
    throw new Error("Unable to create private Kubernetes access files.");
  }
  const kubeconfig = access.file;
  const deploymentContext = { ...context, environment: { ...context.environment, KUBECONFIG: kubeconfig } };
  await runCommand(deploymentContext, "aws", [
    "eks", "update-kubeconfig", "--name", runbook.cluster_name, "--region", runbook.region,
    "--kubeconfig", kubeconfig,
  ], { description: "aws eks update-kubeconfig" });
  try {
    context.chmod(kubeconfig, 0o600);
  } catch {
    throw new Error("Unable to protect private Kubernetes access files.");
  }
  return deploymentContext;
}

async function deployCluster(context, outputs) {
  const { runbook } = outputs;
  const deploymentContext = await configureClusterAccess(context, outputs);
  await runCommand(deploymentContext, "kubectl", ["get", "nodes", "--request-timeout=30s"]);
  // deploy.mjs inherits KUBECONFIG for each of its kubectl and Helm subprocesses.
  await runCommand(deploymentContext, process.execPath, ["apps/kubernetes/deploy.mjs"]);
  await runCommand(deploymentContext, "kubectl", [
    "-n", runbook.namespace, "rollout", "status", "deployment/api", "--timeout=5m",
  ]);
  return deploymentContext;
}

async function readCredentials(context) {
  let email;
  let password;
  try {
    email = (await context.readInput("Cognito email: ", { signal: context.signal })).trim();
    password = await context.readSecret("Cognito password: ", { signal: context.signal });
  } catch (failure) {
    context.signal.throwIfAborted();
    const sanitized = new Error("Unable to read Cognito credentials from terminal.");
    sanitized.status = failure?.status ?? 1;
    throw sanitized;
  }
  context.signal.throwIfAborted();
  if (!email || typeof password !== "string" || !password) throw new Error("Cognito email and password are required.");
  return { email, password };
}

async function validateDeployment(context, outputs, { email, password }) {
  const validationContext = { ...context, environment: {
    ...context.environment,
    AWS_REGION: outputs.runbook.region,
    RUN_LIVE_KUBERNETES_POLICY_TESTS: "1",
    KUBERNETES_POLICY_CONFIG_SOURCE: "terraform",
    RUN_LIVE_AWS: "true",
    RUN_LIVE_KUBERNETES_IMPORT: "true",
    LIVE_AWS_API_URL: outputs.api_url_https,
    LIVE_AWS_PANEL_URL: outputs.painel_url,
    LIVE_AWS_USERNAME: email,
    LIVE_AWS_PASSWORD: password,
    LIVE_AWS_OPERATIONAL_TABLE: outputs.runbook.storage.operational_table,
    LIVE_AWS_IMPORT_BUCKET: outputs.runbook.storage.bucket,
  } };
  await runCommand(validationContext, process.execPath, [
    "--test", "--test-concurrency=1", "apps/kubernetes/tests/admission-live.test.mjs",
  ], { description: "Kubernetes admission validation" });
  await runCommand(validationContext, "npm", [
    "run", "test:integration:kubernetes", "--", "-t", "IT-AWS-0(1|2|5|6)",
  ], { cwd: resolve(context.root, "apps/backend/api"), description: "Kubernetes E2E validation" });
  context.log("Kubernetes admission and IT-AWS-01/02/05/06 validation passed.");
  return { status: 0 };
}

function trackPrivateFiles(context, paths, label) {
  context.cleanup.push(() => removePrivateFiles(context, paths, label));
}

function removePrivateFiles(context, paths, label) {
  let failed = false;
  for (const [path, remove] of [[paths.file, context.removeSensitiveFile], [paths.directory, context.removeSensitiveDirectory]]) {
    if (!path) continue;
    try { remove(path); } catch (failure) {
      if (failure?.code !== "ENOENT") failed = true;
    }
  }
  if (failed) throw new Error(`Unable to remove private ${label} files.`);
}

export async function ensureCognitoUser(context, outputs, email, password) {
  const access = {};
  return await withCleanup(async () => {
    try {
      access.directory = context.makeTemporaryDirectory(resolve(tmpdir(), "learner-lab-cognito-"));
      context.chmod(access.directory, 0o700);
      access.file = resolve(access.directory, "input.json");
    } catch {
      throw new Error("Unable to create private Cognito input files.");
    }
    let firstWrite = true;
    const input = { UserPoolId: outputs.cognito_user_pool_id, Username: email };
    const call = async (operation, payload, options = {}) => {
      context.signal.throwIfAborted();
      try {
        context.writeSensitiveFile(access.file, JSON.stringify(payload), { mode: 0o600, flag: firstWrite ? "wx" : "w" });
        firstWrite = false;
      } catch {
        throw new Error("Unable to write private Cognito input files.");
      }
      return await runCommand(context, "aws", [
        "cognito-idp", operation, "--region", outputs.runbook.region,
        "--cli-input-json", `file://${access.file}`, "--output", "json",
        ...(operation === "admin-create-user" ? ["--message-action", "SUPPRESS"] : []),
      ], { description: `Cognito ${operation}`, ...options });
    };
    const existing = await call("admin-get-user", input, { allowedStatuses: [0, 254] });
    if (existing.status !== 0) {
      if (!/\(UserNotFoundException\)/.test(existing.stderr)) throw new Error("Cognito admin-get-user failed.");
      await call("admin-create-user", { ...input, UserAttributes: [
        { Name: "email", Value: email }, { Name: "email_verified", Value: "true" },
      ] });
    }
    await call("admin-set-user-password", { ...input, Password: password, Permanent: true });
    const confirmed = await call("admin-get-user", input);
    let user;
    try { user = JSON.parse(confirmed.stdout); } catch {
      throw new Error("Invalid Cognito user status JSON.");
    }
    if (user?.UserStatus !== "CONFIRMED") throw new Error("Cognito user is not CONFIRMED.");
    // O papel vem do grupo Cognito: sem `engineer`, o usuário inicial lê os
    // diagnósticos, mas recebe 403 ao revisar hipóteses ou pedir reanálise.
    const group = { UserPoolId: outputs.cognito_user_pool_id, GroupName: "engineer" };
    const existingGroup = await call("get-group", group, { allowedStatuses: [0, 254] });
    if (existingGroup.status !== 0) {
      if (!/\(ResourceNotFoundException\)/.test(existingGroup.stderr)) throw new Error("Cognito get-group failed.");
      await call("create-group", {
        ...group,
        Description: "Can review incident hypotheses and request reanalysis",
        Precedence: 10,
      });
    }
    await call("admin-add-user-to-group", { ...input, GroupName: "engineer" });
    return { UserStatus: "CONFIRMED" };
  }, () => removePrivateFiles(context, access, "Cognito input"));
}

async function withPrivateArtifacts(context, operation) {
  const controller = new AbortController();
  context.signal = controller.signal;
  const cancel = (signalName) => {
    if (controller.signal.aborted) return;
    const failure = new Error(`Operation cancelled by ${signalName}.`);
    failure.status = signalName === "SIGINT" ? 130 : 143;
    failure.signalName = signalName;
    controller.abort(failure);
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  context.signalSource.on("SIGINT", interrupt);
  context.signalSource.on("SIGTERM", terminate);
  let result;
  let failure;
  try {
    result = await operation();
    context.signal.throwIfAborted();
  } catch (error) {
    failure = context.signal.aborted && !(error instanceof AggregateError) ? context.signal.reason : error;
    if (context.signal.aborted && failure instanceof AggregateError) failure.status = context.signal.reason.status;
  }
  const cleanupErrors = [];
  // Child executors have settled before any owned file is removed. Each cleanup runs once.
  for (const cleanup of context.cleanup.splice(0).reverse()) {
    try { cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  context.signalSource.removeListener("SIGINT", interrupt);
  context.signalSource.removeListener("SIGTERM", terminate);
  if (cleanupErrors.length) {
    const combined = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      `${failure ? `${failure.message} Cleanup also failed: ` : ""}${cleanupErrors.map((error) => error.message).join(" ")}`);
    combined.status = failure?.status ?? 1;
    throw combined;
  }
  if (failure) throw failure;
  return result;
}

async function setupInfrastructure(context, configuration) {
  const plan = await createPlan(context, configuration);
  if (plan.hasChanges) {
    if (!plan.plannedRunbook) throw new Error("Validated plan does not identify the planned cluster and region.");
    const { clusterName, region } = plan.plannedRunbook;
    const prompt = `Apply validated plan for AWS account ${plan.identity.Account}, region ${region}, planned cluster ${clusterName}, updates ${configuration.update ? "enabled" : "disabled"}?`;
    if (!configuration.yes && !(await context.confirm(prompt, { signal: context.signal }))) throw new Error("Terraform apply was not confirmed.");
    context.signal.throwIfAborted();
    await runCommand(context, "terraform", ["-chdir=apps/fullstack", "apply", "-input=false", plan.planPath], { description: "terraform apply" });
  }
  const outputs = await readDeploymentOutputs(context);
  const credentials = await readCredentials(context);
  await ensureCognitoUser(context, outputs, credentials.email, credentials.password);
  const deploymentContext = await deployCluster(context, outputs);
  return await validateDeployment(deploymentContext, outputs, credentials);
}

async function collectEvidence(context) {
  const identity = await checkPrerequisites(context);
  const runbook = await readRunbook(context);
  const clusterContext = await configureClusterAccess(context, { runbook });
  for (const args of [
    ["get", "nodes", "-o", "wide"],
    ["get", "deployments,cronjobs,jobs,hpa,pdb", "-A"],
    ["get", "validatingadmissionpolicies,validatingadmissionpolicybindings"],
  ]) {
    const result = await runCommand(clusterContext, "kubectl", args);
    // These fixed get commands expose default resource tables only. Reject
    // diagnostic text and terminal controls before reflecting their stdout.
    const table = parseEvidenceTable(result.stdout, args[1]);
    context.log(`Evidence read completed: kubectl ${args.join(" ")}.`);
    if (table) context.log(table);
  }
  context.log(`Evidence collected for AWS account ${identity.Account}, region ${runbook.region}, cluster ${runbook.cluster_name}, namespace ${runbook.namespace}.`);
  return { status: 0 };
}

function parseEvidenceTable(stdout, target) {
  const invalid = () => { throw new Error("Unsafe or malformed Kubernetes evidence table output."); };
  if (Buffer.byteLength(stdout) > 64 * 1024 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(stdout)) invalid();
  const name = /^[a-z0-9][a-z0-9.-]{0,252}$/;
  const age = /^(?:<unknown>|(?:\d+[smhdwy])+|0s)$/;
  const integer = /^\d+$/;
  const ratio = /^\d+\/\d+$/;
  const dns = (value) => name.test(value);
  const typedName = (prefix) => (value) => value.startsWith(`${prefix}/`) && dns(value.slice(prefix.length + 1));
  const param = (value) => /^(?:<unset>|<none>|[A-Za-z][A-Za-z0-9.\/-]*)$/.test(value);
  const namespace = (value) => NAMESPACE.test(value);
  const schemas = new Map();
  const add = (header, validators, render = (columns) => columns.join("\t")) => schemas.set(header, { validators, render });
  if (target === "nodes") {
    add("NAME STATUS ROLES AGE VERSION INTERNAL-IP EXTERNAL-IP OS-IMAGE KERNEL-VERSION CONTAINER-RUNTIME", null, (columns) => {
      if (columns.length !== 10 || !dns(columns[0]) || !/^(?:Ready|NotReady|Unknown)(?:,SchedulingDisabled)?$/.test(columns[1]) ||
        !/^(?:<none>|[a-z0-9,-]+)$/.test(columns[2]) || !age.test(columns[3]) || !/^v\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(columns[4]) ||
        !columns.slice(5, 7).every((value) => /^(?:<none>|[a-fA-F0-9:.]+)$/.test(value)) ||
        !/^[A-Za-z0-9 .()_/-]+$/.test(columns.slice(7, -2).join(" ")) ||
        !/^[A-Za-z0-9._+-]+$/.test(columns.at(-2)) || !/^[a-z]+:\/\/[A-Za-z0-9._+-]+$/.test(columns.at(-1))) invalid();
      // Omit the variable-width OS image column; render validated metadata only.
      return [...columns.slice(0, 7), columns.at(-2), columns.at(-1)].join("\t");
    });
  } else if (target === "deployments,cronjobs,jobs,hpa,pdb") {
    add("NAMESPACE NAME READY UP-TO-DATE AVAILABLE AGE", [namespace, typedName("deployment.apps"), (v) => ratio.test(v), (v) => integer.test(v), (v) => integer.test(v), (v) => age.test(v)]);
    add("NAMESPACE NAME SCHEDULE TIMEZONE SUSPEND ACTIVE LAST SCHEDULE AGE", [namespace, typedName("cronjob.batch"), (v) => /^(?:[0-9*,/\-]+ ){4}[0-9*,/\-]+$/.test(v), (v) => /^(?:<none>|[A-Za-z_]+(?:\/[A-Za-z_]+)+)$/.test(v), (v) => /^(?:True|False)$/.test(v), (v) => integer.test(v), (v) => v === "<none>" || age.test(v), (v) => age.test(v)]);
    const job = [namespace, typedName("job.batch"), (v) => ratio.test(v), (v) => age.test(v), (v) => age.test(v)];
    add("NAMESPACE NAME COMPLETIONS DURATION AGE", job);
    add("NAMESPACE NAME STATUS COMPLETIONS DURATION AGE", [...job.slice(0, 2), (v) => /^(?:Running|Complete|Failed|Suspended|FailureTarget|SuccessCriteriaMet)$/.test(v), ...job.slice(2)]);
    add("NAMESPACE NAME REFERENCE TARGETS MINPODS MAXPODS REPLICAS AGE", [namespace, typedName("horizontalpodautoscaler.autoscaling"), (v) => /^(?:Deployment|StatefulSet|ReplicaSet)\/[a-z0-9][a-z0-9.-]*$/.test(v), (v) => /^(?:(?:[a-z][a-z0-9_-]*: )?(?:<unknown>|\d+(?:m|%)?)\/\d+(?:m|%)?)(?:, (?:[a-z][a-z0-9_-]*: )?(?:<unknown>|\d+(?:m|%)?)\/\d+(?:m|%)?)*$/.test(v), ...Array(3).fill((v) => integer.test(v)), (v) => age.test(v)]);
    add("NAMESPACE NAME MIN AVAILABLE MAX UNAVAILABLE ALLOWED DISRUPTIONS AGE", [namespace, typedName("poddisruptionbudget.policy"), (v) => /^(?:N\/A|\d+%?)$/.test(v), (v) => /^(?:N\/A|\d+%?)$/.test(v), (v) => integer.test(v), (v) => age.test(v)]);
  } else if (target === "validatingadmissionpolicies,validatingadmissionpolicybindings") {
    add("NAME VALIDATIONS PARAMKIND AGE", [typedName("validatingadmissionpolicy.admissionregistration.k8s.io"), (v) => integer.test(v), param, (v) => age.test(v)]);
    add("NAME POLICYNAME PARAMREF AGE", [typedName("validatingadmissionpolicybinding.admissionregistration.k8s.io"), dns, param, (v) => age.test(v)]);
  } else invalid();
  let schema;
  const output = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) { schema = undefined; continue; }
    const columns = line.trim().split(/\s{2,}|\t+/);
    const normalized = line.trim().replace(/\s+/g, " ");
    if (schemas.has(normalized)) {
      schema = schemas.get(normalized);
      output.push(target === "nodes" ? "NAME\tSTATUS\tROLES\tAGE\tVERSION\tINTERNAL-IP\tEXTERNAL-IP\tKERNEL-VERSION\tCONTAINER-RUNTIME" : normalized);
      continue;
    }
    if (!schema) invalid();
    if (schema.validators && (columns.length !== schema.validators.length || !schema.validators.every((validate, index) => validate(columns[index])))) invalid();
    output.push(schema.render(columns));
  }
  return output.join("\n");
}

function guardTerraformEnvironment(environment) {
  if (Object.keys(environment).some((key) => /^(?:TF_WORKSPACE|TF_DATA_DIR|TF_CLI_ARGS(?:_.*)?|TF_CLI_CONFIG_FILE)$/.test(key)))
    throw new Error("Terraform environment overrides for state, workspace, CLI arguments or CLI configuration are not allowed.");
}

function guardLocalDestroyBackend(context) {
  const readOptional = (file) => {
    try { return context.readLocalFile(resolve(context.root, "apps/fullstack", file), "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error("Unable to verify local Terraform workspace and backend.");
    }
  };
  const workspace = readOptional(".terraform/environment");
  if (workspace !== undefined && workspace.trim() !== "default")
    throw new Error("Destroy requires the default local Terraform workspace.");
  const metadata = readOptional(".terraform/terraform.tfstate");
  if (metadata === undefined) return;
  let backend;
  try { backend = JSON.parse(metadata)?.backend; } catch {
    throw new Error("Unable to verify local Terraform backend configuration.");
  }
  if (backend && (backend.type !== "local" ||
    (backend.config?.path && resolve(context.root, "apps/fullstack", backend.config.path) !== resolve(context.root, "apps/fullstack/terraform.tfstate"))))
    throw new Error("Destroy requires the canonical local Terraform state backend.");
}

function validateLocalDestroyState(context, identity, runbook) {
  let state;
  try {
    state = JSON.parse(context.readLocalFile(resolve(context.root, "apps/fullstack/terraform.tfstate"), "utf8"));
  } catch {
    throw new Error("Destroy requires readable, valid local Terraform state.");
  }
  const resources = Array.isArray(state?.resources) ? state.resources : [];
  const clusters = resources.filter((resource) => resource.mode === "managed" && resource.type === "aws_eks_cluster");
  const cluster = clusters?.[0]?.instances?.[0]?.attributes;
  const arn = cluster?.arn?.match(/^arn:([^:]+):eks:([^:]+):(\d{12}):cluster\/(.+)$/);
  const savedRunbook = state?.outputs?.kubernetes_runbook?.value;
  // A saved destroy plan deletes the entire stack, so reject foreign-account
  // ARN references in every managed resource, not just the EKS cluster.
  const ownsAccount = (value) => {
    if (typeof value === "string") {
      const account = value.match(/^arn:[^:]+:[^:]+:[^:]*:(\d{12}):/);
      return !account || account[1] === identity.Account;
    }
    if (value && typeof value === "object") return Object.values(value).every(ownsAccount);
    return true;
  };
  if (state?.version !== 4 || typeof state.lineage !== "string" || !state.lineage ||
    !Number.isInteger(state.serial) || state.serial < 0 || clusters?.length !== 1 ||
    clusters[0].instances?.length !== 1 || !arn || arn[3] !== identity.Account ||
    !identity.Arn.includes(`:${identity.Account}:`) || arn[2] !== runbook.region ||
    arn[4] !== runbook.cluster_name || cluster.name !== runbook.cluster_name ||
    runbook.namespace !== "view-show" || runbook.cluster_name !== "view-show-iac-cluster" ||
    savedRunbook?.cluster_name !== runbook.cluster_name || savedRunbook?.region !== runbook.region ||
    savedRunbook?.namespace !== runbook.namespace ||
    !resources.filter((resource) => resource.mode === "managed").every((resource) => ownsAccount(resource.instances)))
    throw new Error("Destroy local state does not prove the view-show EKS target in the current AWS account.");
}

async function destroyInfrastructure(context) {
  guardLocalDestroyBackend(context);
  const identity = await checkPrerequisites(context);
  const runbook = await readRunbook(context);
  validateLocalDestroyState(context, identity, runbook);
  const directory = resolve(context.root, "apps/fullstack/.terraform-artifacts");
  const file = resolve(directory, `kubernetes.destroy.${randomUUID()}.tfplan`);
  try {
    context.makeDirectory(directory, { recursive: true, mode: 0o700 });
    context.chmod(directory, 0o700);
    // Exclusive creation reserves the invocation's name before Terraform writes it.
    context.writeSensitiveFile(file, "", { mode: 0o600, flag: "wx" });
    trackPrivateFiles(context, { file }, "Terraform destroy plan");
  } catch {
    throw new Error("Unable to create private Terraform destroy plan file.");
  }
  const planPath = relative(resolve(context.root, "apps/fullstack"), file);
  await runCommand(context, "terraform", [
    "-chdir=apps/fullstack", "plan", "-destroy", "-input=false", "-state=terraform.tfstate", `-out=${planPath}`,
  ], { description: "terraform destroy plan" });
  try { context.chmod(file, 0o600); } catch {
    throw new Error("Unable to protect private Terraform destroy plan file.");
  }
  const phrase = `DESTROY view-show EKS in account ${identity.Account}`;
  let answer;
  try { answer = await context.readInput(`Type exactly ${phrase}: `, { signal: context.signal }); } catch {
    context.signal.throwIfAborted();
    throw new Error("Unable to read destroy confirmation.");
  }
  context.signal.throwIfAborted();
  if (answer !== phrase) throw new Error("Destroy was not confirmed with the exact phrase.");
  await runCommand(context, "terraform", ["-chdir=apps/fullstack", "apply", "-input=false", planPath], { description: "terraform destroy apply" });
  context.log(`Destroyed saved Terraform plan for view-show EKS in AWS account ${identity.Account}.`);
  return { status: 0 };
}

export async function runLearnerLabKubernetes({
  argv = [],
  execute = executeCommand,
  log = (line) => process.stdout.write(`${line}\n`),
  error = (line) => process.stderr.write(`${line}\n`),
  confirm = confirmFromTerminal,
  readInput = readInputFromTerminal,
  readSecret = readSecretFromTerminal,
  environment = process.env,
  root = ROOT,
  chmod = chmodSync,
  makeDirectory = mkdirSync,
  makeTemporaryDirectory = mkdtempSync,
  writeSensitiveFile = writeFileSync,
  removeSensitiveFile = unlinkSync,
  removeSensitiveDirectory = rmdirSync,
  readLocalFile = readFileSync,
  signalSource = process,
} = {}) {
  try {
    const configuration = parseLearnerLabArguments(argv);
    if (["plan", "setup", "destroy"].includes(configuration.command)) guardTerraformEnvironment(environment);
    if (configuration.command === "help") {
      log(HELP);
      return { status: 0 };
    }
    const context = {
      execute, log, error, confirm, readInput, readSecret, environment, root,
      chmod, makeDirectory, makeTemporaryDirectory, writeSensitiveFile,
      removeSensitiveFile, removeSensitiveDirectory, readLocalFile,
      cleanup: [], signalSource,
    };
    return await withPrivateArtifacts(context, async () => {
      if (configuration.command === "check") {
        const identity = await checkPrerequisites(context);
        log(`Kubernetes preflight passed for AWS account ${identity.Account}.`);
        return { status: 0, identity };
      }
      if (configuration.command === "plan") {
        const result = await createPlan(context, configuration);
        log(`Kubernetes plan validated: ${result.hasChanges ? "changes" : "no changes"}.`);
        return result;
      }
      if (configuration.command === "setup") return await setupInfrastructure(context, configuration);
      if (configuration.command === "evidence") return await collectEvidence(context);
      if (configuration.command === "destroy") return await destroyInfrastructure(context);
      if (configuration.command === "deploy") {
        await checkPrerequisites(context);
        const outputs = await readDeploymentOutputs(context);
        await deployCluster(context, outputs);
        return { status: 0 };
      }
      if (configuration.command === "validate") {
        await checkPrerequisites(context);
        const outputs = await readDeploymentOutputs(context);
        const credentials = await readCredentials(context);
        const deploymentContext = await configureClusterAccess(context, outputs);
        return await validateDeployment(deploymentContext, outputs, credentials);
      }
      throw new Error(`${configuration.command} is not implemented yet.`);
    });
  } catch (failure) {
    error(failure.message);
    return { status: failure.status ?? 1 };
  }
}

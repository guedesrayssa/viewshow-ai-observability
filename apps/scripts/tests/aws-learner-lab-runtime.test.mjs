import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLearnerLabArguments,
  runLearnerLabKubernetes,
} from "../lib/learner-lab-kubernetes-runtime.mjs";
import * as kubernetesRuntime from "../lib/learner-lab-kubernetes-runtime.mjs";

test("secret terminal input hides typed characters and restores raw mode", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const modes = [];
  input.setRawMode = (mode) => { input.isRaw = mode; modes.push(mode); };
  let visible = "";
  output.on("data", (chunk) => { visible += chunk; });
  const answer = kubernetesRuntime.readSecretFromTerminal("Password: ", { input, output });
  input.write("secret-value\r");
  assert.equal(await answer, "secret-value");
  assert.equal(visible, "Password: \n");
  assert.equal(input.isRaw, false);
  assert.deepEqual(modes, [true, false]);
});

test("secret terminal input restores terminal state on interruption and rejects non-TTY input", async () => {
  for (const external of [false, true]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    const controller = new AbortController();
    const answer = kubernetesRuntime.readSecretFromTerminal("Password: ", { input, output, signal: controller.signal });
    if (external) controller.abort(new Error("SIGTERM"));
    else input.write("\u0003");
    await assert.rejects(answer);
    assert.equal(input.isRaw, false);
    // Node caches a data decoder for future readline sessions; close removes
    // the keypress consumer and all owned terminal handlers.
    assert.equal(input.listenerCount("keypress"), 0);
  }
  await assert.rejects(() => kubernetesRuntime.readSecretFromTerminal("Password: ", { input: new PassThrough(), output: new PassThrough() }), /terminal/i);
});

test("secret terminal input preserves a previously raw terminal and rejects EOF", { timeout: 1000 }, async () => {
  for (const eof of [false, true]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    input.isRaw = true;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    const answer = kubernetesRuntime.readSecretFromTerminal("Password: ", { input, output });
    if (eof) input.write("\u0004");
    else input.write("secret-value\r");
    if (eof) await assert.rejects(answer, /terminal/);
    else assert.equal(await answer, "secret-value");
    assert.equal(input.isRaw, true);
    assert.equal(input.listenerCount("keypress"), 0);
  }
});

test("Cognito input is actually private on disk and removed after confirmation", async () => {
  const calls = [];
  let file;
  let directory;
  const context = {
    root: "/workspace", environment: {}, signal: new AbortController().signal,
    makeTemporaryDirectory: (prefix) => { directory = mkdtempSync(prefix); return directory; },
    chmod: chmodSync, writeSensitiveFile: writeFileSync,
    removeSensitiveFile: unlinkSync, removeSensitiveDirectory: rmdirSync,
    execute: async (program, args) => {
      calls.push({ program, args });
      file = args[args.indexOf("--cli-input-json") + 1].slice("file://".length);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const input = JSON.parse(readFileSync(file, "utf8"));
      if (args[1] === "admin-set-user-password") assert.equal(input.Password, "private-password");
      return { status: 0, stdout: '{"UserStatus":"CONFIRMED"}', stderr: "" };
    },
  };
  try {
    assert.deepEqual(await kubernetesRuntime.ensureCognitoUser(context, { runbook, cognito_user_pool_id: "pool" }, "learner@example.test", "private-password"), { UserStatus: "CONFIRMED" });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(directory), false);
    assert.equal(JSON.stringify(calls).includes("private-password"), false);
  } finally {
    if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

test("Cognito provisioning preserves sanitized operation and cleanup errors in AggregateError", async () => {
  const context = {
    root: "/workspace", environment: {}, signal: new AbortController().signal,
    makeTemporaryDirectory: () => "/private/cognito-test", chmod: () => {}, writeSensitiveFile: () => {},
    removeSensitiveFile: () => { throw new Error("private-password"); }, removeSensitiveDirectory: () => {},
    execute: async () => ({ status: 254, stdout: "", stderr: "AccessDeniedException private-password" }),
  };
  await assert.rejects(
    () => kubernetesRuntime.ensureCognitoUser(context, { runbook, cognito_user_pool_id: "pool" }, "learner@example.test", "private-password"),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /Cognito admin-get-user failed/);
      assert.match(error.errors[1].message, /Unable to remove private Cognito input files/);
      assert.equal([error.message, ...error.errors.map(({ message }) => message)].join(" ").includes("private-password"), false);
      return true;
    },
  );
});

test("cleanup preserves both the primary failure and its own failure", async () => {
  const primary = new Error("policy did not type-check");
  const cleanup = new Error("temporary policy deletion failed");
  await assert.rejects(
    () => kubernetesRuntime.withCleanup(async () => { throw primary; }, async () => { throw cleanup; }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  );
});

test("cleanup runs once on success and on failure and preserves successful results", async () => {
  for (const fail of [false, true]) {
    let cleaned = 0;
    const operation = async () => { if (fail) throw new Error("primary"); return "result"; };
    const result = kubernetesRuntime.withCleanup(operation, async () => { cleaned++; });
    if (fail) await assert.rejects(result, /primary/);
    else assert.equal(await result, "result");
    assert.equal(cleaned, 1);
  }
  await assert.rejects(() => kubernetesRuntime.withCleanup(async () => "result", async () => { throw new Error("cleanup"); }), /cleanup/);
});

const script = fileURLToPath(new URL("../aws-learner-lab.mjs", import.meta.url));
const identity = {
  Account: "123456789012",
  Arn: "arn:aws:sts::123456789012:assumed-role/LabRole/session",
  UserId: "AROATEST:session",
};
const runbook = {
  cluster_name: "view-show-iac-cluster",
  region: "us-east-1",
  namespace: "view-show",
  imports_namespace: "view-show-imports",
  storage: { bucket: "view-show-ingestion", operational_table: "view-show-iac-operacional" },
};
const plannedRunbook = { clusterName: runbook.cluster_name, region: runbook.region, namespace: runbook.namespace };

function fakeTeardownRuntime({ phrase = `DESTROY view-show EKS in account ${identity.Account}`, stateAccount = identity.Account, invalidState = false, failPhase } = {}) {
  const runtime = fakeDeploymentRuntime({ failPhase });
  runtime.options.readLocalFile = (path) => {
    runtime.events.push({ kind: "readState", path });
    if (path !== "unused" && !path.endsWith("/fullstack/terraform.tfstate")) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return invalidState ? "state-secret-invalid" : JSON.stringify({
      version: 4, lineage: "test-lineage", serial: 1,
      outputs: { kubernetes_runbook: { value: runbook } },
      resources: [{ mode: "managed", type: "aws_eks_cluster", name: "principal", instances: [{ attributes: {
        name: runbook.cluster_name, arn: `arn:aws:eks:${runbook.region}:${stateAccount}:cluster/${runbook.cluster_name}`,
      } }] }],
    });
  };
  runtime.options.readInput = async (prompt) => { runtime.events.push({ kind: "phrase", prompt }); return phrase; };
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    if (args[1] === "plan" && args.includes("-destroy")) {
      runtime.calls.push({ program, args, options });
      runtime.events.push({ kind: "execute", program, args });
      return { status: failPhase === "plan" ? 1 : 0, stdout: "destroy-plan-secret", stderr: "destroy-plan-secret" };
    }
    return execute(program, args, options);
  };
  return runtime;
}

const evidenceTables = {
  nodes: "NAME  STATUS  ROLES  AGE  VERSION  INTERNAL-IP  EXTERNAL-IP  OS-IMAGE  KERNEL-VERSION  CONTAINER-RUNTIME\nnode-1  Ready  <none>  1d  v1.30.0  10.0.0.1  <none>  Amazon Linux 2023  6.1.1  containerd://1.7.0\nnode-2  Ready  <none>  2d  v1.30.0  10.0.0.2  <none>  Amazon Linux 2023  6.1.1  containerd://1.7.0\n",
  "deployments,cronjobs,jobs,hpa,pdb": "NAMESPACE  NAME  READY  UP-TO-DATE  AVAILABLE  AGE\nview-show  deployment.apps/api  1/1  1  1  1d\n\nNAMESPACE  NAME  SCHEDULE  TIMEZONE  SUSPEND  ACTIVE  LAST SCHEDULE  AGE\nview-show  cronjob.batch/import  0 * * * *  <none>  False  0  10m  1d\n\nNAMESPACE  NAME  STATUS  COMPLETIONS  DURATION  AGE\nview-show  job.batch/import-1  Complete  1/1  10s  1d\n\nNAMESPACE  NAME  REFERENCE  TARGETS  MINPODS  MAXPODS  REPLICAS  AGE\nview-show  horizontalpodautoscaler.autoscaling/api  Deployment/api  cpu: 10%/70%  1  3  1  1d\n\nNAMESPACE  NAME  MIN AVAILABLE  MAX UNAVAILABLE  ALLOWED DISRUPTIONS  AGE\nview-show  poddisruptionbudget.policy/api  1  N/A  0  1d\n",
  "validatingadmissionpolicies,validatingadmissionpolicybindings": "NAME  VALIDATIONS  PARAMKIND  AGE\nvalidatingadmissionpolicy.admissionregistration.k8s.io/guard  3  <unset>  1d\n\nNAME  POLICYNAME  PARAMREF  AGE\nvalidatingadmissionpolicybinding.admissionregistration.k8s.io/guard  guard  <unset>  1d\n",
};

test("evidence collects only named runbook and read-only cluster observations without secrets", async () => {
  const runtime = fakeDeploymentRuntime();
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    const result = execute(program, args, options);
    return program === "kubectl" && args[0] === "get" ? { ...result, stdout: evidenceTables[args[1]] } : result;
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["evidence"] })).status, 0, runtime.errors.join("\n"));
  assert.deepEqual(runtime.calls.filter(({ program, args }) => program === "terraform" && args[1] === "output").map(({ args }) => args), [
    ["-chdir=apps/fullstack", "output", "-json", "kubernetes_runbook"],
  ]);
  assert.deepEqual(runtime.calls.filter(({ program, args }) => program === "kubectl" && args[0] !== "version").map(({ args }) => args), [
    ["get", "nodes", "-o", "wide"],
    ["get", "deployments,cronjobs,jobs,hpa,pdb", "-A"],
    ["get", "validatingadmissionpolicies,validatingadmissionpolicybindings"],
  ]);
  assert.equal(runtime.calls.some(({ args }) => args.some((arg) => ["init", "plan", "apply", "create", "delete"].includes(arg))), false);
  assert.equal(runtime.events.some(({ kind }) => ["readInput", "readSecret", "confirm"].includes(kind)), false);
  assert.equal(JSON.stringify([...runtime.logs, ...runtime.errors]).includes("deployment-secret-never-log"), false);
  assert.match(runtime.logs.join("\n"), /123456789012/);
  assert.match(runtime.logs.join("\n"), /node-1/);
  assert.match(runtime.logs.join("\n"), /node-2/);
  assert.match(runtime.logs.join("\n"), /namespace view-show/);
  assert.match(runtime.logs.join("\n"), /NAME POLICYNAME PARAMREF AGE/);
  assert.match(runtime.logs.join("\n"), /validatingadmissionpolicybinding\.admissionregistration\.k8s\.io\/guard\tguard\t<unset>\t1d/);
});

test("Terraform planning and mutations reject environment overrides before any executor call", async () => {
  for (const command of ["plan", "setup", "destroy"]) {
    for (const key of ["TF_WORKSPACE", "TF_DATA_DIR", "TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_CLI_ARGS_apply", "TF_CLI_ARGS_destroy", "TF_CLI_ARGS_init", "TF_CLI_CONFIG_FILE"]) {
      const runtime = fakeTeardownRuntime();
      runtime.options.environment[key] = "injected-secret-argument";
      assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: [command] })).status, 1, `${command} ${key}`);
      assert.equal(runtime.calls.length, 0, `${command} ${key}`);
      assert.equal(runtime.errors.join("\n").includes("injected-secret-argument"), false);
    }
  }
});

test("destroy refuses persisted non-default workspaces and alternate backends before reading outputs or planning", async () => {
  for (const [file, content] of [
    [".terraform/environment", "other-workspace"],
    [".terraform/terraform.tfstate", JSON.stringify({ backend: { type: "s3", config: {} } })],
    [".terraform/terraform.tfstate", JSON.stringify({ backend: { type: "local", config: { path: "foreign.tfstate" } } })],
  ]) {
    const runtime = fakeTeardownRuntime();
    const read = runtime.options.readLocalFile;
    runtime.options.readLocalFile = (path) => path.endsWith(`/fullstack/${file}`) ? content : read(path);
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1, file);
    assert.equal(runtime.calls.some(({ args }) => args[1] === "output" || args.includes("-destroy")), false);
    assert.equal(runtime.events.some(({ kind }) => kind === "phrase"), false);
  }
});

test("evidence rejects malformed later rows and unknown schemas without reflecting them", async () => {
  const cases = [
    ["nodes", `${evidenceTables.nodes}later-sentinel-secret\n`],
    ["nodes", evidenceTables.nodes.replace("node-2  Ready", "node-2  Ready  extra")],
    ["nodes", evidenceTables.nodes.replace("Ready  <none>", "Ready\u202e  <none>")],
    ["deployments,cronjobs,jobs,hpa,pdb", `${evidenceTables["deployments,cronjobs,jobs,hpa,pdb"]}later-sentinel-secret\n`],
    ["validatingadmissionpolicies,validatingadmissionpolicybindings", "NAME UNKNOWN AGE\nname later-sentinel-secret 1d\n"],
    ["validatingadmissionpolicies,validatingadmissionpolicybindings", `${evidenceTables["validatingadmissionpolicies,validatingadmissionpolicybindings"]}later-sentinel-secret\n`],
  ];
  for (const [target, stdout] of cases) {
    const runtime = fakeDeploymentRuntime();
    const execute = runtime.options.execute;
    runtime.options.execute = (program, args, options) => {
      const result = execute(program, args, options);
      return program === "kubectl" && args[0] === "get" ? { ...result, stdout: args[1] === target ? stdout : evidenceTables[args[1]] } : result;
    };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["evidence"] })).status, 1, target);
    assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("later-sentinel-secret"), false);
  }
});

test("evidence rejects oversized, diagnostic and control-escaped stdout without reflecting it", async () => {
  for (const stdout of ["sentinel-secret", "NAME STATUS AGE\nnode-1\u001b[31msecret", "NAME STATUS AGE\nnode-1\u0000secret", `NAME STATUS AGE\n${"x".repeat(65537)}`]) {
    const runtime = fakeDeploymentRuntime();
    const execute = runtime.options.execute;
    runtime.options.execute = (program, args, options) => {
      const result = execute(program, args, options);
      return program === "kubectl" && args[0] === "get" ? { ...result, stdout } : result;
    };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["evidence"] })).status, 1);
    assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes(stdout), false);
    assert.equal(runtime.calls.filter(({ program, args }) => program === "kubectl" && args[0] === "get").length, 1);
  }
});

test("destroy plans before exact confirmation and applies only its unique protected saved plan", async () => {
  const paths = [];
  for (let index = 0; index < 2; index++) {
    const runtime = fakeTeardownRuntime();
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 0, runtime.errors.join("\n"));
    const plan = runtime.calls.find(({ args }) => args.includes("-destroy"));
    const path = plan.args.at(-1).slice("-out=".length);
    paths.push(path);
    assert.match(path, /^\.terraform-artifacts\/kubernetes\.destroy\.[a-zA-Z0-9-]+\.tfplan$/);
    assert.deepEqual(plan.args, ["-chdir=apps/fullstack", "plan", "-destroy", "-input=false", "-state=terraform.tfstate", `-out=${path}`]);
    assert.deepEqual(runtime.calls.find(({ args }) => args[1] === "apply").args, ["-chdir=apps/fullstack", "apply", "-input=false", path]);
    const state = runtime.events.findIndex(({ kind }) => kind === "readState");
    const planned = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args.includes("-destroy"));
    const prompted = runtime.events.findIndex(({ kind }) => kind === "phrase");
    assert.ok(state >= 0 && state < planned && planned < prompted);
    assert.match(runtime.events[prompted].prompt, /DESTROY view-show EKS in account 123456789012/);
    assert.ok(runtime.events.some(({ kind, mode, target }) => kind === "chmod" && mode === 0o600 && target.endsWith(path)));
    assert.equal(runtime.events.filter(({ kind, target }) => kind === "unlink" && target.endsWith(path)).length, 1);
    assert.equal(JSON.stringify([...runtime.logs, ...runtime.errors]).includes("destroy-plan-secret"), false);
  }
  assert.notEqual(paths[0], paths[1]);
});

test("destroy rejects non-exact phrases and --yes without applying", async () => {
  for (const phrase of ["yes", "", `DESTROY view-show EKS in account ${identity.Account} `, "DESTROY view-show EKS in account 999999999999"]) {
    const runtime = fakeTeardownRuntime({ phrase });
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
    assert.equal(runtime.calls.some(({ args }) => args[1] === "apply"), false);
    assert.equal(runtime.calls.filter(({ args }) => args.includes("-destroy")).length, 1);
    assert.equal(runtime.events.filter(({ kind }) => kind === "unlink").length, 1);
  }
  const runtime = fakeTeardownRuntime();
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy", "--yes"] })).status, 1);
  assert.equal(runtime.calls.length, 0);
});

test("destroy rejects invalid or foreign local state and plan failure before requesting its phrase", async () => {
  for (const options of [{ invalidState: true }, { stateAccount: "999999999999" }, { failPhase: "plan" }]) {
    const runtime = fakeTeardownRuntime(options);
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
    assert.equal(runtime.events.some(({ kind }) => kind === "phrase"), false);
    assert.equal(runtime.calls.some(({ args }) => args[1] === "apply"), false);
    assert.equal(runtime.errors.join("\n").includes("state-secret-invalid"), false);
  }
});

test("destroy stops and cleans its plan on permission, prompt and apply failures", async () => {
  for (const phase of ["permissions", "prompt", "apply"]) {
    const runtime = fakeTeardownRuntime({ failPhase: phase });
    if (phase === "permissions") runtime.options.chmod = (path) => { if (path.endsWith(".tfplan")) throw new Error("private-path-secret"); };
    if (phase === "prompt") runtime.options.readInput = () => { throw new Error("prompt-secret"); };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
    assert.equal(runtime.events.filter(({ kind }) => kind === "unlink").length, 1);
    assert.equal(runtime.calls.filter(({ args }) => args[1] === "apply").length, phase === "apply" ? 1 : 0);
    assert.equal(runtime.errors.join("\n").includes("private-path-secret"), false);
    assert.equal(runtime.errors.join("\n").includes("prompt-secret"), false);
  }
});

test("destroy rejects absent, mismatched and ambiguous EKS local state before planning", async () => {
  const base = fakeTeardownRuntime();
  const valid = JSON.parse(base.options.readLocalFile("unused"));
  const states = [null, {}, { ...valid, resources: [] }, { ...valid, resources: [...valid.resources, ...valid.resources] },
    { ...valid, outputs: {} }, { ...valid, resources: [{ ...valid.resources[0], instances: [{ attributes: { name: runbook.cluster_name, arn: `arn:aws:eks:sa-east-1:${identity.Account}:cluster/${runbook.cluster_name}` } }] }] }];
  for (const state of states) {
    const runtime = fakeTeardownRuntime();
    runtime.options.readLocalFile = () => JSON.stringify(state);
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
    assert.equal(runtime.calls.some(({ args }) => args.includes("-destroy")), false);
    assert.equal(runtime.events.some(({ kind }) => kind === "phrase"), false);
  }
  const runtime = fakeTeardownRuntime();
  runtime.options.readLocalFile = () => { throw new Error("state-path-secret"); };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
  assert.equal(runtime.errors.join("\n").includes("state-path-secret"), false);
});

test("destroy rejects managed resources from another account even when the EKS target matches", async () => {
  const runtime = fakeTeardownRuntime();
  const state = JSON.parse(runtime.options.readLocalFile("unused"));
  state.resources.push({ mode: "managed", type: "aws_iam_role", instances: [{ attributes: { arn: "arn:aws:iam::999999999999:role/other" } }] });
  runtime.options.readLocalFile = () => JSON.stringify(state);
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["destroy"] })).status, 1);
  assert.equal(runtime.calls.some(({ args }) => args.includes("-destroy")), false);
});

function fakeRuntime({ identityOutput = JSON.stringify(identity), failAt } = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  return {
    calls, logs, errors,
    options: {
      root: "/workspace",
      environment: { AWS_REGION: "us-east-1" },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      execute: (program, args, options) => {
        calls.push({ program, args, options });
        if (calls.length === failAt) return { status: 1, stdout: "", stderr: "failed" };
        return {
          status: 0,
          stdout: program === "aws" ? identityOutput : "tool version",
          stderr: "",
        };
      },
    },
  };
}

test("argument parser accepts the exact command and flag surface", () => {
  assert.deepEqual(parseLearnerLabArguments([]), { command: "help", yes: false, update: false });
  for (const alias of ["--help", "-h"])
    assert.deepEqual(parseLearnerLabArguments([alias]), { command: "help", yes: false, update: false });
  assert.deepEqual(parseLearnerLabArguments(["setup", "--yes", "--update"]), {
    command: "setup", yes: true, update: true,
  });
  for (const command of ["help", "check", "plan", "setup", "deploy", "validate", "evidence", "destroy"])
    assert.deepEqual(parseLearnerLabArguments([command]), { command, yes: false, update: false });
  assert.deepEqual(parseLearnerLabArguments(["plan", "--update"]), { command: "plan", yes: false, update: true });
  assert.deepEqual(parseLearnerLabArguments(["setup", "--update", "--yes"]), { command: "setup", yes: true, update: true });
  assert.throws(() => parseLearnerLabArguments(["check", "--yes"]), /does not accept/);
  assert.throws(() => parseLearnerLabArguments(["plan", "--yes"]), /does not accept/);
  assert.throws(() => parseLearnerLabArguments(["deploy", "--update"]), /does not accept/);
  assert.throws(() => parseLearnerLabArguments(["ecs"]), /unknown command/);
  assert.throws(() => parseLearnerLabArguments(["setup", "--profile", "lab"]), /does not accept/);
  assert.throws(() => parseLearnerLabArguments(["setup", "--yes", "--yes"]), /duplicate/);
  assert.throws(() => parseLearnerLabArguments(["help", "check"]), /does not accept/);
});

test("help and invalid commands remain offline", async () => {
  const logs = [];
  const errors = [];
  const execute = () => { throw new Error("must remain offline"); };
  const options = { execute, log: (line) => logs.push(line), error: (line) => errors.push(line) };
  for (const argv of [[], ["help"], ["--help"], ["-h"]])
    assert.equal((await runLearnerLabKubernetes({ ...options, argv })).status, 0);
  assert.match(logs.join("\n"), /plan \[--update\]/);
  assert.match(logs.join("\n"), /setup \[--yes\] \[--update\]/);
  assert.equal((await runLearnerLabKubernetes({ ...options, argv: ["ecs"] })).status, 1);
  assert.match(errors.join("\n"), /unknown command/);
});

test("canonical executable prints help and rejects invalid commands offline", () => {
  const help = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Kubernetes/);
  const invalid = spawnSync(process.execPath, [script, "ecs"], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unknown command/);
});

test("check runs four preflight commands in order and validates AWS identity", async () => {
  const runtime = fakeRuntime();
  const result = await runLearnerLabKubernetes({ ...runtime.options, argv: ["check"] });
  assert.equal(result.status, 0);
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(runtime.calls.map(({ program, args }) => [program, args]), [
    ["terraform", ["version"]],
    ["aws", ["sts", "get-caller-identity", "--output", "json"]],
    ["kubectl", ["version", "--client"]],
    ["helm", ["version"]],
  ]);
  for (const call of runtime.calls) {
    assert.equal(call.options.cwd, "/workspace");
    assert.deepEqual(call.options.env, { AWS_REGION: "us-east-1" });
  }
});

test("check rejects malformed or missing account and ARN before reporting success", async () => {
  for (const identityOutput of ["not-json", "null", "{}", JSON.stringify({ Account: "123", Arn: identity.Arn }), JSON.stringify({ Account: identity.Account }), JSON.stringify({ Account: identity.Account, Arn: "" })]) {
    const runtime = fakeRuntime({ identityOutput });
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["check"] })).status, 1);
    assert.equal(runtime.calls.length, 2);
    assert.equal(runtime.logs.length, 0);
    assert.match(runtime.errors.join("\n"), /identity/i);
  }
});

test("check stops on each failed preflight command", async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const runtime = fakeRuntime({ failAt });
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["check"] })).status, 1);
    assert.equal(runtime.calls.length, failAt);
    assert.equal(runtime.logs.length, 0);
  }
});

let privatePlanSequence = 0;
function fakePlanRuntime({ planStatus = 2, failPhase, update = false, planData, workspace = "default" } = {}) {
  const runtime = fakeRuntime();
  const events = [];
  const planJSON = JSON.stringify(planData ?? {
    sensitive: "plan-secret-never-log", resource_changes: [],
    planned_values: { outputs: { kubernetes_runbook: { value: runbook } } },
  });
  const preflightExecute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    events.push({ kind: "execute", program, args });
    if (args[0] !== "-chdir=apps/fullstack" && program !== process.execPath)
      return preflightExecute(program, args, options);
    runtime.calls.push({ program, args, options });
    const phase = program === process.execPath ? "gate" : args[1];
    return {
      status: phase === failPhase ? 1 : phase === "plan" ? planStatus : 0,
      stdout: phase === "show" || phase === "gate" ? planJSON : phase === "workspace" ? `${workspace}\n` : "terraform output",
      stderr: planJSON,
    };
  };
  runtime.options.chmod = (target, mode) => events.push({ kind: "chmod", target, mode });
  runtime.options.makeDirectory = (target, options) => events.push({ kind: "mkdir", target, options });
  runtime.options.makeTemporaryDirectory = (prefix) => {
    const target = `${prefix}${++privatePlanSequence}`;
    events.push({ kind: "mkdtemp", prefix, target });
    return target;
  };
  runtime.options.removeSensitiveFile = (target) => events.push({ kind: "unlink", target });
  runtime.options.removeSensitiveDirectory = (target) => events.push({ kind: "rmdir", target });
  runtime.options.argv = ["plan", ...(update ? ["--update"] : [])];
  return { ...runtime, events, planJSON };
}

test("plan initializes Terraform, protects the saved plan and sends JSON only through gate stdin", async () => {
  const runtime = fakePlanRuntime();
  const result = await runLearnerLabKubernetes(runtime.options);
  const planPath = runtime.calls.find(({ args }) => args[1] === "plan").args.at(-1).slice("-out=".length);
  assert.match(planPath, /^\.terraform-artifacts\/plan-[^/]+\/kubernetes.tfplan$/);
  assert.deepEqual(result, {
    status: 0, planPath, hasChanges: true, identity, plannedRunbook,
  });
  assert.deepEqual(runtime.calls.slice(4).map(({ program, args }) => [program, args]), [
    ["terraform", ["-chdir=apps/fullstack", "init", "-input=false"]],
    ["terraform", ["-chdir=apps/fullstack", "workspace", "show"]],
    ["terraform", ["-chdir=apps/fullstack", "plan", "-input=false", "-detailed-exitcode", `-out=${planPath}`]],
    ["terraform", ["-chdir=apps/fullstack", "show", "-json", planPath]],
    [process.execPath, ["apps/scripts/terraform/validate-kubernetes-plan.mjs"]],
  ]);
  const gate = runtime.calls.at(-1);
  assert.equal(gate.options.input, runtime.planJSON);
  assert.equal(gate.options.cwd, "/workspace");
  assert.equal(runtime.calls.some(({ args }) => args.includes("apply")), false);
  const directory = "/workspace/apps/fullstack/.terraform-artifacts";
  assert.deepEqual(runtime.events.find(({ kind }) => kind === "mkdir"), {
    kind: "mkdir", target: directory, options: { recursive: true, mode: 0o700 },
  });
  const directoryChmod = runtime.events.findIndex(({ kind, target, mode }) => kind === "chmod" && target === directory && mode === 0o700);
  const plan = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[1] === "plan");
  const planChmod = runtime.events.findIndex(({ kind, target, mode }) => kind === "chmod" && target === `/workspace/apps/fullstack/${planPath}` && mode === 0o600);
  const show = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[1] === "show");
  assert.ok(directoryChmod >= 0 && directoryChmod < plan);
  assert.ok(planChmod > plan && planChmod < show);
  assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
  assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("plan-secret-never-log"), false);
});

test("plan rejects a persisted non-default Terraform workspace before planning", async () => {
  const runtime = fakePlanRuntime({ workspace: "staging" });
  assert.equal((await runLearnerLabKubernetes(runtime.options)).status, 1);
  assert.deepEqual(runtime.calls.slice(4).map(({ program, args }) => [program, args]), [
    ["terraform", ["-chdir=apps/fullstack", "init", "-input=false"]],
    ["terraform", ["-chdir=apps/fullstack", "workspace", "show"]],
  ]);
  assert.match(runtime.errors.join("\n"), /default Terraform workspace/i);
});

test("plan treats exit zero as no-op and exit two as changes", async () => {
  for (const planStatus of [0, 2]) {
    const runtime = fakePlanRuntime({ planStatus });
    const result = await runLearnerLabKubernetes(runtime.options);
    assert.equal(result.status, 0);
    assert.equal(result.hasChanges, planStatus === 2);
    assert.equal(runtime.calls.at(-1).args[0], "apps/scripts/terraform/validate-kubernetes-plan.mjs");
  }
});

test("plan rejects every non-success Terraform status before show and gate", async () => {
  for (const planStatus of [1, 3, 127, null]) {
    const runtime = fakePlanRuntime({ planStatus });
    assert.equal((await runLearnerLabKubernetes(runtime.options)).status, 1);
    assert.equal(runtime.calls.at(-1)?.args[1], "plan");
    assert.equal(runtime.calls.some(({ program }) => program === process.execPath), false);
    assert.equal(runtime.logs.length, 0);
    assert.equal(runtime.errors.join("\n").includes("plan-secret-never-log"), false);
  }
});

test("plan passes update authorization to the gate only when explicitly requested", async () => {
  for (const update of [false, true]) {
    const runtime = fakePlanRuntime({ update });
    assert.equal((await runLearnerLabKubernetes(runtime.options)).status, 0);
    assert.deepEqual(runtime.calls.at(-1).args, [
      "apps/scripts/terraform/validate-kubernetes-plan.mjs", ...(update ? ["--update"] : []),
    ]);
  }
});

test("plan stops at initialization, show or gate failures without exposing gate input", async () => {
  for (const failPhase of ["init", "show", "gate"]) {
    const runtime = fakePlanRuntime({ failPhase });
    assert.equal((await runLearnerLabKubernetes(runtime.options)).status, 1);
    const last = runtime.calls.at(-1);
    assert.equal(last?.program === process.execPath ? "gate" : last?.args[1], failPhase);
    assert.equal(runtime.calls.some(({ args }) => args.includes("apply")), false);
    assert.equal(runtime.logs.length, 0);
    assert.equal(runtime.errors.join("\n").includes("plan-secret-never-log"), false);
  }
});

test("plan suppresses sensitive input even if the gate executor throws it in an error", async () => {
  const runtime = fakePlanRuntime();
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    if (program === process.execPath) throw new Error(`execution failed: ${options.input}`);
    return execute(program, args, options);
  };
  assert.equal((await runLearnerLabKubernetes(runtime.options)).status, 1);
  assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("plan-secret-never-log"), false);
});

function fakeDeploymentRuntime({ confirmed = true, outputRunbook = runbook, malformedRunbook = false, ...planOptions } = {}) {
  const runtime = fakePlanRuntime(planOptions);
  const execute = runtime.options.execute;
  const outputs = {
    kubernetes_runbook: malformedRunbook ? "invalid-runbook-secret" : JSON.stringify(outputRunbook),
    painel_url: "https://panel.example.test\n",
    api_url_https: "https://api.example.test\n",
    cognito_user_pool_id: "us-east-1_pool\n",
    cognito_client_id: "client-id\n",
  };
  runtime.options.execute = (program, args, options) => {
    const phase = args[1] === "output" ? `output:${args.at(-1)}` :
      program === "aws" && args[0] === "eks" ? "kubeconfig" :
      program === "kubectl" && args[0] === "get" ? "nodes" :
      program === process.execPath && args[0] === "apps/kubernetes/deploy.mjs" ? "deploy" :
      program === "kubectl" && args.includes("rollout") ? "rollout" : undefined;
    if (!phase) return execute(program, args, options);
    runtime.calls.push({ program, args, options });
    runtime.events.push({ kind: "execute", program, args });
    return {
      status: phase === planOptions.failPhase ? 1 : 0,
      stdout: args[1] === "output" ? outputs[args.at(-1)] : "deployment-secret-never-log",
      stderr: "deployment-secret-never-log",
    };
  };
  runtime.options.confirm = (prompt) => {
    runtime.events.push({ kind: "confirm", prompt });
    return confirmed;
  };
  runtime.options.readInput = async (prompt) => {
    runtime.events.push({ kind: "readInput", prompt });
    return "learner@example.test";
  };
  runtime.options.readSecret = async (prompt) => {
    runtime.events.push({ kind: "readSecret", prompt });
    return "cognito-password-never-log";
  };
  const deployExecute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    if (args[0] !== "cognito-idp") return deployExecute(program, args, options);
    runtime.calls.push({ program, args, options });
    runtime.events.push({ kind: "execute", program, args });
    return { status: 0, stdout: JSON.stringify({ Username: "learner@example.test", UserStatus: "CONFIRMED" }), stderr: "" };
  };
  const makePlanDirectory = runtime.options.makeTemporaryDirectory;
  runtime.options.makeTemporaryDirectory = (prefix) => {
    if (prefix.includes(".terraform-artifacts")) return makePlanDirectory(prefix);
    runtime.events.push({ kind: "mkdtemp", prefix });
    return prefix.includes("cognito") ? "/private/learner-lab-cognito-test" : "/private/learner-lab-kubernetes-test";
  };
  runtime.options.writeSensitiveFile = (target, content, options) => runtime.events.push({ kind: "write", target, content, options });
  runtime.options.removeSensitiveFile = (target) => runtime.events.push({ kind: "unlink", target });
  runtime.options.removeSensitiveDirectory = (target) => runtime.events.push({ kind: "rmdir", target });
  return runtime;
}

test("setup rejects the gate before confirmation and apply even with --yes", async () => {
  for (const yes of [false, true]) {
    const runtime = fakeDeploymentRuntime({ failPhase: "gate" });
    const result = await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", ...(yes ? ["--yes"] : [])] });
    assert.equal(result.status, 1);
    assert.equal(runtime.calls.at(-1)?.args[0], "apps/scripts/terraform/validate-kubernetes-plan.mjs");
    assert.equal(runtime.events.some(({ kind }) => kind === "confirm"), false);
    assert.equal(runtime.calls.some(({ args }) => args.includes("apply")), false);
  }
});

test("setup updates an existing Cognito user through private input files and confirms its status", async () => {
  const runtime = fakeDeploymentRuntime();
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 0);
  const calls = runtime.calls.filter(({ args }) => args[0] === "cognito-idp");
  assert.deepEqual(calls.map(({ args }) => args[1]), ["admin-get-user", "admin-set-user-password", "admin-get-user", "get-group", "admin-add-user-to-group"]);
  for (const { args } of calls) {
    assert.ok(args.includes("--cli-input-json"));
    assert.match(args[args.indexOf("--cli-input-json") + 1], /^file:\/\/\/private\/learner-lab-cognito-test\//);
    assert.equal(args.includes("--password"), false);
    assert.equal(args.includes("learner@example.test"), false);
    assert.ok(args.includes(runbook.region));
  }
  const writes = runtime.events.filter(({ kind, target }) => kind === "write" && target.includes("cognito"));
  const passwordWrite = writes.find(({ content }) => JSON.parse(content).Password);
  assert.ok(passwordWrite);
  assert.deepEqual(JSON.parse(passwordWrite.content), {
    UserPoolId: "us-east-1_pool", Username: "learner@example.test", Password: "cognito-password-never-log", Permanent: true,
  });
  assert.ok(writes.every(({ options }) => options.mode === 0o600));
  assert.equal(writes[0].options.flag, "wx");
  assert.ok(runtime.events.some(({ kind, target, mode }) => kind === "chmod" && target === "/private/learner-lab-cognito-test" && mode === 0o700));
  assert.equal(JSON.stringify({ calls, commands: runtime.calls.map(({ program, args }) => ({ program, args })), logs: runtime.logs, errors: runtime.errors }).includes("cognito-password-never-log"), false);
  const deletion = runtime.events.findIndex(({ kind, target }) => kind === "unlink" && target.includes("cognito"));
  const creation = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[1] === "admin-set-user-password");
  assert.ok(creation < deletion);
});

test("setup creates a missing Cognito user with suppressed messaging before setting a permanent password", async () => {
  const runtime = fakeDeploymentRuntime();
  const execute = runtime.options.execute;
  let reads = 0;
  runtime.options.execute = (program, args, options) => {
    const result = execute(program, args, options);
    if (args[1] === "admin-get-user" && reads++ === 0)
      return { status: 254, stdout: "", stderr: "An error occurred (UserNotFoundException): private detail" };
    return result;
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 0);
  const calls = runtime.calls.filter(({ args }) => args[0] === "cognito-idp");
  assert.deepEqual(calls.map(({ args }) => args[1]), ["admin-get-user", "admin-create-user", "admin-set-user-password", "admin-get-user", "get-group", "admin-add-user-to-group"]);
  const create = calls[1];
  assert.ok(create.args.includes("--message-action"));
  assert.equal(create.args[create.args.indexOf("--message-action") + 1], "SUPPRESS");
  const payload = runtime.events.filter(({ kind, target }) => kind === "write" && target.includes("cognito"))[1];
  assert.deepEqual(JSON.parse(payload.content).UserAttributes, [
    { Name: "email", Value: "learner@example.test" }, { Name: "email_verified", Value: "true" },
  ]);
});

test("setup creates the engineer group when missing and adds the initial user to it", async () => {
  const runtime = fakeDeploymentRuntime();
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    const result = execute(program, args, options);
    if (args[1] === "get-group")
      return { status: 254, stdout: "", stderr: "An error occurred (ResourceNotFoundException): group not found" };
    return result;
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 0);
  const calls = runtime.calls.filter(({ args }) => args[0] === "cognito-idp");
  assert.deepEqual(calls.slice(-3).map(({ args }) => args[1]), ["get-group", "create-group", "admin-add-user-to-group"]);
  const payloads = runtime.events
    .filter(({ kind, target }) => kind === "write" && target.includes("cognito"))
    .map(({ content }) => JSON.parse(content));
  assert.deepEqual(payloads.at(-3), { UserPoolId: "us-east-1_pool", GroupName: "engineer" });
  assert.equal(payloads.at(-2).GroupName, "engineer");
  assert.deepEqual(payloads.at(-1), { UserPoolId: "us-east-1_pool", Username: "learner@example.test", GroupName: "engineer" });
});

test("an unexpected get-group failure stops setup without creating a group", async () => {
  const runtime = fakeDeploymentRuntime();
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    const result = execute(program, args, options);
    if (args[1] === "get-group") return { status: 254, stdout: "", stderr: "AccessDeniedException" };
    return result;
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1);
  const operations = runtime.calls.filter(({ args }) => args[0] === "cognito-idp").map(({ args }) => args[1]);
  assert.equal(operations.includes("create-group"), false);
  assert.equal(operations.includes("admin-add-user-to-group"), false);
});

test("Cognito failures stop setup, remain redacted, and clean the private input", async () => {
  for (const failPhase of ["admin-get-user", "admin-set-user-password", "confirmation", "invalid-json", "execute-throw", "write"]) {
    const runtime = fakeDeploymentRuntime();
    const execute = runtime.options.execute;
    let reads = 0;
    runtime.options.execute = (program, args, options) => {
      const result = execute(program, args, options);
      if (args[0] !== "cognito-idp") return result;
      if (args[1] === "admin-get-user") reads++;
      if (failPhase === "execute-throw") throw new Error("cognito-password-never-log");
      if (args[1] === failPhase) return { status: 254, stdout: "cognito-password-never-log", stderr: "AccessDeniedException cognito-password-never-log" };
      if (reads === 2 && args[1] === "admin-get-user") {
        if (failPhase === "confirmation") return { status: 0, stdout: JSON.stringify({ UserStatus: "FORCE_CHANGE_PASSWORD" }), stderr: "" };
        if (failPhase === "invalid-json") return { status: 0, stdout: "cognito-password-never-log", stderr: "" };
      }
      return result;
    };
    if (failPhase === "write") {
      const write = runtime.options.writeSensitiveFile;
      runtime.options.writeSensitiveFile = (target, content, options) => {
        if (target.includes("cognito")) throw new Error("cognito-password-never-log");
        write(target, content, options);
      };
    }
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1, failPhase);
    assert.equal(runtime.calls.some(({ args }) => args[0] === "apps/kubernetes/deploy.mjs"), false, failPhase);
    assert.equal(runtime.events.filter(({ kind, target }) => kind === "unlink" && target.includes("cognito")).length, 1, failPhase);
    assert.equal(runtime.events.filter(({ kind, target }) => kind === "rmdir" && target.includes("cognito")).length, 1, failPhase);
    assert.equal(runtime.errors.join("\n").includes("cognito-password-never-log"), false);
  }
});

test("Cognito input cleanup follows child settlement after SIGINT and SIGTERM", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const runtime = fakeDeploymentRuntime();
    const signalSource = new EventEmitter();
    const execute = runtime.options.execute;
    runtime.options.execute = async (program, args, options) => {
      const result = execute(program, args, options);
      if (args[1] === "admin-set-user-password") {
        signalSource.emit(signal);
        await Promise.resolve();
        runtime.events.push({ kind: "child-close" });
      }
      return result;
    };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"], signalSource })).status, signal === "SIGINT" ? 130 : 143);
    const settled = runtime.events.findIndex(({ kind }) => kind === "child-close");
    const cleaned = runtime.events.findIndex(({ kind, target }) => kind === "unlink" && target.includes("cognito"));
    assert.ok(settled >= 0 && settled < cleaned);
    assert.equal(runtime.calls.some(({ args }) => args[0] === "apps/kubernetes/deploy.mjs"), false);
    assert.equal(signalSource.listenerCount(signal), 0);
  }
});

test("Cognito operation plus cleanup failures are aggregated and sanitized", async () => {
  const runtime = fakeDeploymentRuntime();
  const execute = runtime.options.execute;
  runtime.options.execute = (program, args, options) => {
    const result = execute(program, args, options);
    return args[1] === "admin-set-user-password" ? { status: 254, stdout: "", stderr: "cognito-password-never-log" } : result;
  };
  const remove = runtime.options.removeSensitiveFile;
  runtime.options.removeSensitiveFile = (target) => {
    remove(target);
    if (target.includes("cognito")) throw new Error("cognito-password-never-log");
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1);
  assert.match(runtime.errors.join("\n"), /operation and cleanup failed/);
  assert.equal(runtime.errors.join("\n").includes("cognito-password-never-log"), false);
});

test("Cognito cancellation preserves cleanup failure and cancellation exit status", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const runtime = fakeDeploymentRuntime();
    const signalSource = new EventEmitter();
    const execute = runtime.options.execute;
    runtime.options.execute = async (program, args, options) => {
      const result = execute(program, args, options);
      if (args[1] === "admin-set-user-password") signalSource.emit(signal);
      return result;
    };
    const remove = runtime.options.removeSensitiveFile;
    runtime.options.removeSensitiveFile = (target) => {
      remove(target);
      if (target.includes("cognito")) throw new Error("cognito-password-never-log");
    };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"], signalSource })).status, signal === "SIGINT" ? 130 : 143);
    assert.match(runtime.errors.join("\n"), /operation and cleanup failed/);
    assert.equal(runtime.errors.join("\n").includes("cognito-password-never-log"), false);
    assert.equal(signalSource.listenerCount(signal), 0);
  }
});

test("standalone validate reads credentials interactively and runs only admission and targeted Kubernetes E2E", async () => {
  const runtime = fakeDeploymentRuntime();
  const originalEnvironment = { ...runtime.options.environment };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["validate"] })).status, 0, runtime.errors.join("\n"));
  assert.equal(runtime.events.filter(({ kind }) => kind === "readInput").length, 1);
  assert.equal(runtime.events.filter(({ kind }) => kind === "readSecret").length, 1);
  assert.equal(runtime.calls.some(({ args }) => args[0] === "cognito-idp" || args[0] === "apps/kubernetes/deploy.mjs" || args.includes("apply")), false);
  const admission = runtime.calls.find(({ args }) => args.includes("apps/kubernetes/tests/admission-live.test.mjs"));
  const e2e = runtime.calls.find(({ program }) => program === "npm");
  assert.deepEqual(admission?.args, ["--test", "--test-concurrency=1", "apps/kubernetes/tests/admission-live.test.mjs"]);
  assert.equal(admission.program, process.execPath);
  assert.equal(admission.options.cwd, "/workspace");
  assert.deepEqual(e2e?.args, ["run", "test:integration:kubernetes", "--", "-t", "IT-AWS-0(1|2|5|6)"]);
  const packageJSON = JSON.parse(readFileSync(new URL("../../backend/api/package.json", import.meta.url), "utf8"));
  assert.match(packageJSON.scripts["test:integration:kubernetes"], /--maxWorkers=2\b/);
  assert.equal(e2e.options.cwd, "/workspace/apps/backend/api");
  const expected = {
    ...originalEnvironment, KUBECONFIG: "/private/learner-lab-kubernetes-test/kubeconfig",
    RUN_LIVE_KUBERNETES_POLICY_TESTS: "1", KUBERNETES_POLICY_CONFIG_SOURCE: "terraform",
    RUN_LIVE_AWS: "true", RUN_LIVE_KUBERNETES_IMPORT: "true",
    LIVE_AWS_API_URL: "https://api.example.test", LIVE_AWS_PANEL_URL: "https://panel.example.test",
    LIVE_AWS_USERNAME: "learner@example.test", LIVE_AWS_PASSWORD: "cognito-password-never-log",
    LIVE_AWS_OPERATIONAL_TABLE: runbook.storage.operational_table, LIVE_AWS_IMPORT_BUCKET: runbook.storage.bucket,
  };
  assert.deepEqual(admission.options.env, expected);
  assert.deepEqual(e2e.options.env, expected);
  assert.deepEqual(runtime.options.environment, originalEnvironment);
  assert.equal(JSON.stringify({ commands: runtime.calls.map(({ program, args }) => ({ program, args })), logs: runtime.logs, errors: runtime.errors }).includes("cognito-password-never-log"), false);
  assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
});

test("validation children use the validated runbook region over a conflicting inherited AWS region", async () => {
  for (const command of ["validate", "setup"]) {
    const runtime = fakeDeploymentRuntime();
    runtime.options.environment.AWS_REGION = "sa-east-1";
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: [command, ...(command === "setup" ? ["--yes"] : [])] })).status, 0);
    const children = runtime.calls.filter(({ program, args }) =>
      args.includes("apps/kubernetes/tests/admission-live.test.mjs") || program === "npm");
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.options.env.AWS_REGION, runbook.region);
    assert.equal(runtime.options.environment.AWS_REGION, "sa-east-1");
  }
});

test("setup reuses the Cognito credentials after Helm deployment for the same validation path", async () => {
  const runtime = fakeDeploymentRuntime();
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 0);
  const rollout = runtime.calls.findIndex(({ args }) => args.includes("rollout"));
  const admission = runtime.calls.findIndex(({ args }) => args.includes("apps/kubernetes/tests/admission-live.test.mjs"));
  const e2e = runtime.calls.findIndex(({ program }) => program === "npm");
  assert.ok(rollout < admission && admission < e2e);
  assert.equal(runtime.events.filter(({ kind }) => kind === "readInput").length, 1);
  assert.equal(runtime.events.filter(({ kind }) => kind === "readSecret").length, 1);
  const writes = runtime.events.filter(({ kind, content }) => kind === "write" && content.includes('"Password"'));
  assert.equal(runtime.calls[e2e].options.env.LIVE_AWS_PASSWORD, JSON.parse(writes[0].content).Password);
  assert.equal(runtime.calls[e2e].options.env.KUBECONFIG, "/private/learner-lab-kubernetes-test/kubeconfig");
});

test("validation stops after each failed child and never leaks child diagnostics or credentials", async () => {
  for (const phase of ["admission", "e2e"]) for (const throws of [false, true]) {
    const runtime = fakeDeploymentRuntime();
    const execute = runtime.options.execute;
    runtime.options.execute = (program, args, options) => {
      const result = execute(program, args, options);
      if ((phase === "admission" && args.includes("apps/kubernetes/tests/admission-live.test.mjs")) || (phase === "e2e" && program === "npm")) {
        if (throws) throw new Error(JSON.stringify(options.env));
        return { status: 1, stdout: JSON.stringify(options.env), stderr: JSON.stringify(options.env) };
      }
      return result;
    };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["validate"] })).status, 1);
    if (phase === "admission") assert.equal(runtime.calls.some(({ program }) => program === "npm"), false);
    assert.equal(runtime.errors.join("\n").includes("cognito-password-never-log"), false);
    assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
  }
});

test("invalid credentials and prompt errors stop before Cognito or validation without leaking errors", async () => {
  for (const invalid of ["email", "password", "prompt"]) {
    const runtime = fakeDeploymentRuntime();
    if (invalid === "email") runtime.options.readInput = async () => "  ";
    if (invalid === "password") runtime.options.readSecret = async () => "";
    if (invalid === "prompt") runtime.options.readSecret = async () => { throw new Error("cognito-password-never-log"); };
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1);
    assert.equal(runtime.calls.some(({ args }) => args[0] === "cognito-idp" || args[0] === "eks"), false);
    assert.equal(runtime.errors.join("\n").includes("cognito-password-never-log"), false);
  }
});

test("setup no-op skips confirmation and apply and deploys after kubeconfig", async () => {
  const runtime = fakeDeploymentRuntime({ planStatus: 0 });
  const result = await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup"] });
  assert.equal(result.status, 0, runtime.errors.join("\n"));
  assert.equal(runtime.events.some(({ kind }) => kind === "confirm"), false);
  assert.equal(runtime.calls.some(({ args }) => args.includes("apply")), false);
  const gate = runtime.calls.findIndex(({ args }) => args[0] === "apps/scripts/terraform/validate-kubernetes-plan.mjs");
  const kubeconfig = runtime.calls.findIndex(({ args }) => args[0] === "eks");
  const nodes = runtime.calls.findIndex(({ args }) => args[0] === "get");
  const deploy = runtime.calls.findIndex(({ args }) => args[0] === "apps/kubernetes/deploy.mjs");
  const rollout = runtime.calls.findIndex(({ args }) => args.includes("rollout"));
  assert.ok(gate < kubeconfig && kubeconfig < nodes && nodes < deploy && deploy < rollout);
});

test("setup changed plan requires confirmation and prompts with the gated planned target", async () => {
  for (const update of [false, true]) {
    const runtime = fakeDeploymentRuntime({ confirmed: false });
    const result = await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", ...(update ? ["--update"] : [])] });
    assert.equal(result.status, 1);
    const prompt = runtime.events.find(({ kind }) => kind === "confirm")?.prompt;
    assert.match(prompt ?? "", /123456789012/);
    assert.match(prompt, /us-east-1/);
    assert.match(prompt, /view-show-iac-cluster/);
    assert.match(prompt, /planned/i);
    assert.match(prompt, update ? /updates enabled/i : /updates disabled/i);
    assert.equal(runtime.calls.some(({ args }) => args.includes("apply") || args.includes("output")), false);
  }
});

test("setup confirmed changes apply the saved validated plan before reading outputs", async () => {
  for (const yes of [false, true]) {
    const runtime = fakeDeploymentRuntime();
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", ...(yes ? ["--yes"] : [])] })).status, 0);
    const gate = runtime.calls.findIndex(({ args }) => args[0] === "apps/scripts/terraform/validate-kubernetes-plan.mjs");
    const apply = runtime.calls.findIndex(({ args }) => args[1] === "apply");
    const output = runtime.calls.findIndex(({ args }) => args[1] === "output");
    const planPath = runtime.calls.find(({ args }) => args[1] === "show").args.at(-1);
    assert.deepEqual(runtime.calls[apply].args, ["-chdir=apps/fullstack", "apply", "-input=false", planPath]);
    assert.ok(gate < apply && apply < output);
    assert.equal(runtime.events.filter(({ kind }) => kind === "confirm").length, yes ? 0 : 1);
  }
});

test("plan exposes only proven non-sensitive target fields and setup derives a planned name from variables", async () => {
  const runtime = fakeDeploymentRuntime({ confirmed: false, planData: {
    variables: { deployment_namespace: { value: "view-show" }, regiao: { value: "us-east-1" } },
    sensitive: "plan-secret-never-log", resource_changes: [],
  } });
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup"] })).status, 1);
  assert.match(runtime.events.find(({ kind }) => kind === "confirm")?.prompt ?? "", /view-show-iac-cluster/);
  const planned = fakePlanRuntime();
  const result = await runLearnerLabKubernetes(planned.options);
  assert.deepEqual(result.plannedRunbook, plannedRunbook);
  assert.equal(JSON.stringify(result).includes("plan-secret-never-log"), false);
  assert.equal(JSON.stringify(result).includes("storage"), false);
});

test("deploy reads only named outputs and never initializes, plans or applies Terraform", async () => {
  const runtime = fakeDeploymentRuntime();
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 0, runtime.errors.join("\n"));
  const terraform = runtime.calls.filter(({ program }) => program === "terraform");
  assert.deepEqual(terraform.map(({ args }) => args).filter((args) => args[0] !== "version"), [
    ["-chdir=apps/fullstack", "output", "-json", "kubernetes_runbook"],
    ...["painel_url", "api_url_https", "cognito_user_pool_id", "cognito_client_id"].map((name) => ["-chdir=apps/fullstack", "output", "-raw", name]),
  ]);
  assert.equal(runtime.calls.some(({ args }) => args.some((arg) => ["init", "plan", "apply"].includes(arg))), false);
  assert.deepEqual(runtime.calls.at(-3).args, ["get", "nodes", "--request-timeout=30s"]);
  assert.deepEqual(runtime.calls.at(-2).args, ["apps/kubernetes/deploy.mjs"]);
  assert.deepEqual(runtime.calls.at(-1).args, ["-n", "view-show", "rollout", "status", "deployment/api", "--timeout=5m"]);
});

test("deploy keeps kubeconfig private and passes KUBECONFIG to nodes, the Helm child and rollout", async () => {
  const runtime = fakeDeploymentRuntime();
  const originalEnvironment = { ...runtime.options.environment };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 0);
  const kubeconfigCall = runtime.calls.find(({ args }) => args[0] === "eks");
  const path = "/private/learner-lab-kubernetes-test/kubeconfig";
  assert.deepEqual(kubeconfigCall.args, ["eks", "update-kubeconfig", "--name", runbook.cluster_name, "--region", runbook.region, "--kubeconfig", path]);
  const write = runtime.events.find(({ kind }) => kind === "write");
  assert.equal(write.target, path);
  assert.deepEqual(write.options, { mode: 0o600, flag: "wx" });
  const updateIndex = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[0] === "eks");
  const chmodIndex = runtime.events.findIndex(({ kind, target, mode }, index) => index > updateIndex && kind === "chmod" && target === path && mode === 0o600);
  const nodesIndex = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[0] === "get");
  assert.ok(updateIndex < chmodIndex && chmodIndex < nodesIndex);
  assert.ok(runtime.events.some(({ kind, target, mode }) => kind === "chmod" && target === "/private/learner-lab-kubernetes-test" && mode === 0o700));
  for (const call of runtime.calls.filter(({ args }) => args[0] === "get" || args.includes("rollout") || args[0] === "apps/kubernetes/deploy.mjs"))
    assert.deepEqual(call.options.env, { ...originalEnvironment, KUBECONFIG: path });
  assert.deepEqual(runtime.options.environment, originalEnvironment);
  assert.deepEqual(runtime.events.slice(-2), [{ kind: "unlink", target: path }, { kind: "rmdir", target: "/private/learner-lab-kubernetes-test" }]);
  assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("deployment-secret-never-log"), false);
  assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes(path), false);
});

test("deploy initializes the private kubeconfig with valid empty configuration before AWS updates it", async () => {
  const runtime = fakeDeploymentRuntime();
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 0);
  const write = runtime.events.find(({ kind }) => kind === "write");
  assert.doesNotThrow(() => JSON.parse(write.content), "initial kubeconfig must be valid configuration JSON");
  assert.deepEqual(JSON.parse(write.content), {
    apiVersion: "v1", kind: "Config", clusters: [], contexts: [], users: [], "current-context": "",
  });
});

test("setup refuses unproven planned targets before confirmation or apply", async () => {
  const runtime = fakeDeploymentRuntime({ planData: { resource_changes: [] } });
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1);
  assert.equal(runtime.calls.at(-1)?.args[0], "apps/scripts/terraform/validate-kubernetes-plan.mjs");
  assert.equal(runtime.calls.some(({ args }) => args.includes("apply")), false);
  assert.equal(runtime.events.some(({ kind }) => kind === "confirm"), false);
});

test("setup confirmation uses runbook output changes when planned values are not yet available", async () => {
  const runtime = fakeDeploymentRuntime({ confirmed: false, planData: {
    output_changes: { kubernetes_runbook: { after: { cluster_name: "new-lab-cluster", region: "sa-east-1", namespace: "lab" } } },
  } });
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup"] })).status, 1);
  const prompt = runtime.events.find(({ kind }) => kind === "confirm")?.prompt;
  assert.match(prompt ?? "", /new-lab-cluster/);
  assert.match(prompt, /sa-east-1/);
});

test("deploy stops if kubeconfig permissions cannot be protected and redacts filesystem errors", async () => {
  const runtime = fakeDeploymentRuntime();
  const chmod = runtime.options.chmod;
  runtime.options.chmod = (target, mode) => {
    if (target.endsWith("/kubeconfig")) throw new Error(`cannot chmod ${target}: filesystem-secret`);
    chmod(target, mode);
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 1);
  assert.equal(runtime.calls.at(-1)?.args[0], "eks");
  assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
  assert.equal(runtime.errors.join("\n").includes("/private/"), false);
  assert.equal(runtime.errors.join("\n").includes("filesystem-secret"), false);
});

test("deploy rejects malformed or incomplete runbooks before creating kubeconfig", async () => {
  const invalid = [null, {}, ...["cluster_name", "region", "namespace", "imports_namespace"].map((field) => ({ ...runbook, [field]: "" })),
    { ...runbook, storage: {} }, { ...runbook, storage: { ...runbook.storage, operational_table: "" } },
    { ...runbook, cluster_name: "--unsafe" }, { ...runbook, namespace: "bad namespace" }];
  for (const outputRunbook of invalid) {
    const runtime = fakeDeploymentRuntime({ outputRunbook });
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 1);
    assert.equal(runtime.events.some(({ kind }) => kind === "mkdtemp"), false);
    assert.equal(runtime.calls.some(({ args }) => args[0] === "eks"), false);
    assert.match(runtime.errors.join("\n"), /runbook/i);
  }
  const runtime = fakeDeploymentRuntime({ malformedRunbook: true });
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 1);
  assert.equal(runtime.errors.join("\n").includes("invalid-runbook-secret"), false);
});

test("setup stops after every failed infrastructure or deployment phase", async () => {
  for (const failPhase of ["init", "plan", "show", "gate", "apply", "output:kubernetes_runbook", "output:painel_url", "output:api_url_https", "output:cognito_user_pool_id", "output:cognito_client_id", "kubeconfig", "nodes", "deploy", "rollout"]) {
    const runtime = fakeDeploymentRuntime({ failPhase });
    assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["setup", "--yes"] })).status, 1, failPhase);
    const { program, args } = runtime.calls.at(-1) ?? {};
    const lastPhase = args?.[1] === "output" ? `output:${args.at(-1)}` :
      args?.[0] === "eks" ? "kubeconfig" : args?.[0] === "get" ? "nodes" :
      args?.includes("rollout") ? "rollout" : program === process.execPath ?
        args[0] === "apps/kubernetes/deploy.mjs" ? "deploy" : "gate" : args?.[1];
    assert.equal(lastPhase, failPhase);
    assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("deployment-secret-never-log"), false);
    assert.equal([...runtime.logs, ...runtime.errors].join("\n").includes("/private/"), false);
    if (["kubeconfig", "nodes", "deploy", "rollout"].includes(failPhase))
      assert.equal(runtime.events.filter(({ kind, target }) => kind === "unlink" && target.endsWith("/kubeconfig")).length, 1);
  }
});

test("overlapping setups own distinct plans and retain their own validated file through apply", async () => {
  const first = fakeDeploymentRuntime();
  const second = fakeDeploymentRuntime();
  let release;
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  first.options.confirm = async () => {
    waiting();
    await new Promise((resolve) => { release = resolve; });
    return true;
  };
  const firstRun = runLearnerLabKubernetes({ ...first.options, argv: ["setup"] });
  await ready;
  assert.equal(first.events.some(({ kind }) => kind === "unlink"), false);
  assert.equal((await runLearnerLabKubernetes({ ...second.options, argv: ["setup", "--yes"] })).status, 0);
  release();
  assert.equal((await firstRun).status, 0);
  const paths = [first, second].map((runtime) => runtime.calls.find(({ args }) => args[1] === "show").args.at(-1));
  assert.notEqual(paths[0], paths[1]);
  for (const [index, runtime] of [first, second].entries()) {
    assert.equal(runtime.calls.find(({ args }) => args[1] === "apply").args.at(-1), paths[index]);
    const apply = runtime.events.findIndex(({ kind, args }) => kind === "execute" && args[1] === "apply");
    const cleanup = runtime.events.findIndex(({ kind, target }) => kind === "unlink" && target.endsWith("/kubernetes.tfplan"));
    assert.ok(apply < cleanup);
    assert.ok(runtime.events.some(({ kind, target, mode }) => kind === "chmod" && target.endsWith(paths[index].slice(0, -"/kubernetes.tfplan".length)) && mode === 0o700));
    assert.equal(runtime.events.filter(({ kind, target }) => kind === "unlink" && target.endsWith("/kubernetes.tfplan")).length, 1);
  }
});

test("SIGINT and SIGTERM stop subsequent phases and clean kubeconfig only after the child closes", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const runtime = fakeDeploymentRuntime();
    const signalSource = new EventEmitter();
    const execute = runtime.options.execute;
    runtime.options.execute = async (program, args, options) => {
      const result = execute(program, args, options);
      if (args[0] === "apps/kubernetes/deploy.mjs") {
        signalSource.emit(signal);
        signalSource.emit(signal);
        await Promise.resolve();
        runtime.events.push({ kind: "child-close" });
      }
      return result;
    };
    const result = await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"], signalSource });
    assert.equal(result.status, signal === "SIGINT" ? 130 : 143);
    assert.equal(runtime.calls.some(({ args }) => args.includes("rollout")), false);
    const closed = runtime.events.findIndex(({ kind }) => kind === "child-close");
    const cleanup = runtime.events.findIndex(({ kind }) => kind === "unlink");
    assert.ok(closed < cleanup);
    assert.equal(runtime.events.filter(({ kind }) => kind === "unlink").length, 1);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.match(runtime.errors.join("\n"), new RegExp(signal));
    assert.equal(runtime.errors.join("\n").includes("/private/"), false);
  }
});

test("operation and cleanup failures both survive as sanitized diagnostics", async () => {
  const runtime = fakeDeploymentRuntime({ failPhase: "deploy" });
  runtime.options.removeSensitiveFile = (target) => {
    runtime.events.push({ kind: "unlink", target });
    throw new Error(`unlink ${target}: cleanup-secret`);
  };
  runtime.options.removeSensitiveDirectory = (target) => {
    runtime.events.push({ kind: "rmdir", target });
    throw new Error(`rmdir ${target}: cleanup-secret`);
  };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 1);
  assert.match(runtime.errors.join("\n"), /apps\/kubernetes\/deploy.mjs failed \(status 1\)/);
  assert.match(runtime.errors.join("\n"), /Unable to remove private Kubernetes access files/);
  assert.equal(runtime.errors.join("\n").includes("/private/"), false);
  assert.equal(runtime.errors.join("\n").includes("cleanup-secret"), false);
  assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
});

test("partial kubeconfig creation failure still cleans the invocation-owned file and directory", async () => {
  const runtime = fakeDeploymentRuntime();
  runtime.options.writeSensitiveFile = () => { throw new Error("partial-write-secret"); };
  assert.equal((await runLearnerLabKubernetes({ ...runtime.options, argv: ["deploy"] })).status, 1);
  assert.deepEqual(runtime.events.slice(-2).map(({ kind }) => kind), ["unlink", "rmdir"]);
  assert.equal(runtime.errors.join("\n").includes("partial-write-secret"), false);
});

test("ordinary success and failure preserve the process's existing signal listeners", async () => {
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const planned = fakePlanRuntime();
  assert.equal((await runLearnerLabKubernetes(planned.options)).status, 0);
  const failed = fakeDeploymentRuntime({ failPhase: "deploy" });
  assert.equal((await runLearnerLabKubernetes({ ...failed.options, argv: ["deploy"] })).status, 1);
  for (const signal of ["SIGINT", "SIGTERM"])
    assert.deepEqual(process.listeners(signal), before[signal]);
});

test("default executor cancels a real child and closes it before removing kubeconfig", { timeout: 5000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "learner-lab-signal-test-"));
  const tools = join(fixture, "tools");
  mkdirSync(tools);
  mkdirSync(join(fixture, "apps/kubernetes"), { recursive: true });
  const outputValues = { kubernetes_runbook: JSON.stringify(runbook), painel_url: "https://panel.example.test", api_url_https: "https://api.example.test", cognito_user_pool_id: "pool", cognito_client_id: "client" };
  const toolScript = `#!${process.execPath}
import { basename } from 'node:path';
const args = process.argv.slice(2);
const tool = basename(process.argv[1]);
if (tool === 'aws' && args[0] === 'sts') console.log(${JSON.stringify(JSON.stringify(identity))});
if (tool === 'terraform' && args[1] === 'output') console.log(${JSON.stringify(outputValues)}[args.at(-1)]);
`;
  for (const tool of ["terraform", "aws", "kubectl", "helm"])
    writeFileSync(join(tools, tool), toolScript, { mode: 0o700 });
  writeFileSync(join(fixture, "apps/kubernetes/deploy.mjs"), `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync('child-stopped', 'stopped'); process.exit(0); });
writeFileSync('child-ready', 'ready');
setInterval(() => {}, 1000);
`);
  const signalSource = new EventEmitter();
  let kubeconfig;
  let childStoppedBeforeCleanup = false;
  let cancellationSent = false;
  const watcher = watch(fixture, () => {
    if (!cancellationSent && existsSync(join(fixture, "child-ready"))) {
      cancellationSent = true;
      signalSource.emit("SIGTERM");
    }
  });
  const errors = [];
  try {
    const result = await runLearnerLabKubernetes({
      argv: ["deploy"], root: fixture, environment: { PATH: tools }, signalSource,
      log: () => {}, error: (line) => errors.push(line),
      writeSensitiveFile: (path, content, options) => { kubeconfig = path; writeFileSync(path, content, options); },
      removeSensitiveFile: (path) => {
        childStoppedBeforeCleanup = existsSync(join(fixture, "child-stopped"));
        unlinkSync(path);
      },
      removeSensitiveDirectory: rmdirSync,
    });
    assert.equal(result.status, 143, errors.join("\n"));
    assert.equal(childStoppedBeforeCleanup, true);
    assert.equal(readFileSync(join(fixture, "child-stopped"), "utf8"), "stopped");
    assert.equal(existsSync(kubeconfig), false);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  } finally {
    watcher.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

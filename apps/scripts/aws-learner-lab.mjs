#!/usr/bin/env node
// The account must permit EKS and IAM creation; Academy restrictions are not bypassed.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv[2] ?? "help";
const execute = (program, args) => {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (command === "help") {
  console.log(
    "Kubernetes: check | plan | deploy | evidence. Configure apps/fullstack/terraform.tfvars first. See apps/kubernetes/README.md.",
  );
} else if (command === "check") {
  for (const [program, args] of [
    ["terraform", ["version"]],
    ["aws", ["sts", "get-caller-identity"]],
    ["kubectl", ["version", "--client"]],
    ["helm", ["version"]],
  ])
    execute(program, args);
} else if (command === "plan") {
  execute("terraform", ["-chdir=apps/fullstack", "init"]);
  execute("terraform", [
    "-chdir=apps/fullstack",
    "plan",
    "-out=kubernetes.tfplan",
  ]);
  console.log(
    "Revise o plano e aplique conforme o runbook; deploy instala somente o runtime do cluster provisionado.",
  );
} else if (command === "deploy") {
  execute(process.execPath, ["apps/kubernetes/deploy.mjs"]);
} else if (command === "evidence") {
  execute("kubectl", ["get", "deployments,cronjobs,jobs,hpa", "-A"]);
} else {
  throw new Error(
    "Comando ECS retirado. Use apps/kubernetes/README.md para snapshots, migração e operação.",
  );
}

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render } from "./render.mjs";
const directory = dirname(fileURLToPath(import.meta.url));
const infra = resolve(directory, "../fullstack");
function run(program, args, input, capture = false) {
  const result = spawnSync(program, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Neither stdout nor stderr are reflected: Helm and Terraform can include secrets.
    throw new Error(
      `${program} ${args[0]} failed (exit ${result.status ?? "unavailable"}).`,
    );
  }
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}
// An isolated test environment may supply the same contract without migrating
// the existing Terraform-managed ECS stack. This file contains secrets.
const config = process.env.KUBERNETES_CONFIG_FILE
  ? JSON.parse(
      readFileSync(resolve(process.env.KUBERNETES_CONFIG_FILE), "utf8"),
    )
  : JSON.parse(
      run(
        "terraform",
        [`-chdir=${infra}`, "output", "-json", "kubernetes_deployment"],
        undefined,
        true,
      ),
    );
const labIam = config.iam_mode === "learner-lab-existing";
const secretCache = new Map();
async function resolveSecret({ arn, key, optional }) {
  if (!secretCache.has(arn)) {
    const response = spawnSync(
      "aws",
      [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        arn,
        "--region",
        config.region,
        "--query",
        "SecretString",
        "--output",
        "text",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (response.status !== 0) {
      if (optional && response.stderr?.includes("ResourceNotFoundException"))
        return undefined;
      throw new Error("Unable to load a required Secrets Manager value.");
    }
    secretCache.set(arn, response.stdout.trimEnd());
  }
  const text = secretCache.get(arn);
  if (!key) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid live MySQL secret JSON.");
  }
  return String(parsed[key] ?? "");
}
const values = await render(config, resolveSecret);
if (process.argv.includes("--render")) {
  process.stdout.write(JSON.stringify(values));
  process.exit(0);
}
// Refuse to deploy to a stale kubeconfig or another operator-selected cluster.
const contextCluster = run(
  "kubectl",
  [
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={.contexts[0].context.cluster}",
  ],
  undefined,
  true,
);
if (contextCluster !== config.cluster_arn)
  throw new Error(
    "Select the EKS kubeconfig from kubernetes_runbook before deploying.",
  );
run("kubectl", ["cluster-info"]);
const helm = (name, chart, args = [], input) =>
  run(
    "helm",
    [
      "upgrade",
      "--install",
      name,
      chart,
      "--namespace",
      "kube-system",
      "--wait",
      "--timeout",
      "15m",
      ...args,
    ],
    input,
    true,
  );
helm("aws-load-balancer-controller", "aws-load-balancer-controller", [
  "--repo",
  "https://aws.github.io/eks-charts",
  "--version",
  "1.14.0",
  "--set",
  `clusterName=${config.cluster_name}`,
  "--set",
  `region=${config.region}`,
  "--set",
  `vpcId=${config.vpc_id}`,
  "--set",
  "image.tag=v2.14.1",
  "--set",
  "serviceAccount.name=aws-load-balancer-controller",
  ...(labIam
    ? []
    : [
        "--set",
        `serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=${config.system_roles["load-balancer-controller"]}`,
      ]),
]);
console.log("Load Balancer Controller pronto.");
helm("metrics-server", "metrics-server", [
  "--repo",
  "https://kubernetes-sigs.github.io/metrics-server",
  "--version",
  "3.14.0",
]);
helm("cluster-autoscaler", "cluster-autoscaler", [
  "--repo",
  "https://kubernetes.github.io/autoscaler",
  "--version",
  "9.59.0",
  "--set",
  `autoDiscovery.clusterName=${config.cluster_name}`,
  "--set",
  `awsRegion=${config.region}`,
  "--set",
  "image.tag=v1.35.0",
  "--set",
  "rbac.serviceAccount.name=cluster-autoscaler",
  ...(labIam
    ? []
    : [
        "--set",
        `rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=${config.system_roles["cluster-autoscaler"]}`,
      ]),
]);
console.log("Escalonamento de Pods e nós pronto.");
run(
  "helm",
  [
    "upgrade",
    "--install",
    "amazon-cloudwatch-observability",
    "amazon-cloudwatch-observability",
    "--repo",
    "https://aws-observability.github.io/helm-charts",
    "--version",
    "6.7.0",
    "--namespace",
    "amazon-cloudwatch",
    "--create-namespace",
    "--wait",
    "--timeout",
    "15m",
    "-f",
    "-",
  ],
  JSON.stringify({
    clusterName: config.cluster_name,
    region: config.region,
    agent: { serviceAccount: { name: "cloudwatch-agent" } },
    applicationSignals: { enabled: false },
    containerLogs: {
      fluentBit: {
        config: {
          extraFiles: {
            "application-log.conf": readFileSync(
              resolve(directory, "cloudwatch-application.conf"),
              "utf8",
            ),
          },
        },
      },
    },
  }),
  true,
);
console.log("Coleta de logs e Container Insights pronta.");
run(
  "kubectl",
  ["apply", "-f", "-"],
  JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: values.resources.filter((resource) => resource.kind === "Namespace"),
  }),
  true,
);
values.resources = values.resources.filter(
  (resource) => resource.kind !== "Namespace",
);
run(
  "helm",
  [
    "upgrade",
    "--install",
    "view-show",
    resolve(directory, "chart"),
    "--namespace",
    config.namespace,
    "--wait",
    "--timeout",
    "20m",
    "--history-max",
    "5",
    "-f",
    "-",
  ],
  JSON.stringify(values),
  true,
);
run("kubectl", [
  "-n",
  config.namespace,
  "rollout",
  "status",
  "deployment/api",
  "--timeout=600s",
]);
if (config.analysis_enabled)
  run("kubectl", [
    "-n",
    config.namespace,
    "rollout",
    "status",
    "deployment/analysis-worker",
    "--timeout=600s",
  ]);
run(
  "aws",
  [
    "elbv2",
    "wait",
    "target-in-service",
    "--target-group-arn",
    config.target_group_arn,
    "--region",
    config.region,
  ],
  undefined,
  true,
);
const targetHealth = JSON.parse(
  run(
    "aws",
    [
      "elbv2",
      "describe-target-health",
      "--target-group-arn",
      config.target_group_arn,
      "--region",
      config.region,
      "--output",
      "json",
    ],
    undefined,
    true,
  ),
);
if (
  !targetHealth.TargetHealthDescriptions?.some(
    (target) => target.TargetHealth?.State === "healthy",
  )
)
  throw new Error("ALB has no healthy API target after rollout.");
if (config.observability) {
  const { instance_id, dashboard_base64 } = config.observability;
  if (!/^[A-Za-z0-9+/=]+$/.test(dashboard_base64))
    throw new Error("Invalid observability dashboard encoding.");
  const commands = [
    "test -f /opt/view-show-observability/.provisioned",
    `printf '%s' '${dashboard_base64}' | base64 --decode > /opt/view-show-observability/grafana/provisioning/dashboards/json/view-show-aws.json`,
    "chmod 0644 /opt/view-show-observability/grafana/provisioning/dashboards/json/view-show-aws.json",
  ];
  const { Command } = JSON.parse(
    run(
      "aws",
      [
        "ssm",
        "send-command",
        "--instance-ids",
        instance_id,
        "--document-name",
        "AWS-RunShellScript",
        "--region",
        config.region,
        "--parameters",
        JSON.stringify({ commands: ["set -eu", ...commands] }),
        "--output",
        "json",
      ],
      undefined,
      true,
    ),
  );
  run(
    "aws",
    [
      "ssm",
      "wait",
      "command-executed",
      "--command-id",
      Command.CommandId,
      "--instance-id",
      instance_id,
      "--region",
      config.region,
    ],
    undefined,
    true,
  );
  console.log("Dashboard EKS atualizado no Grafana; histórico preservado.");
}
console.log(
  "Deploy Kubernetes concluído. CronJobs manuais permanecem suspensos.",
);

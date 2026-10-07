// Build a private instance of the production renderer contract for owned test data.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const lab = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(lab, "../../../../..");
const out = path.join(
  root,
  "assets/testes-carga/2026-10-06-fechamento-aws/eks-native",
);
function aws(args) {
  const r = spawnSync(
    "aws",
    [...args, "--region", "us-east-1", "--output", "json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw Error("AWS configuration discovery failed");
  return JSON.parse(r.stdout);
}
const account = aws(["sts", "get-caller-identity"]).Account;
if (account !== "239162056821") throw Error("Account mismatch");
const cluster = aws([
  "eks",
  "describe-cluster",
  "--name",
  "view-show-rnf-eks",
]).cluster;
if (
  cluster.status !== "ACTIVE" ||
  cluster.tags?.Purpose !== "rnf-synthetic-tests"
)
  throw Error("Owned cluster is not ACTIVE");
const resources = JSON.parse(readFileSync(path.join(out, "resources.json")));
const edge = JSON.parse(readFileSync(path.join(out, "edge.json")));
const apiDefinition = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  "view-show-iac-api-task:1",
]).taskDefinition;
const workerDefinition = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  "view-show-ingestion-import:1",
]).taskDefinition;
const originalApi = apiDefinition.containerDefinitions.find(
  (c) => c.name === "view-show-iac-api",
);
const originalWorker = workerDefinition.containerDefinitions.find(
  (c) => c.name === "ingestion",
);
const originalMysql = workerDefinition.containerDefinitions.find(
  (c) => c.name === "mysql-snapshot",
);
const apiDigest = aws([
  "ecr",
  "describe-images",
  "--repository-name",
  "view-show-iac-api",
  "--image-ids",
  "imageTag=rnf-d5339f3-20261006",
]).imageDetails[0].imageDigest;
const workerDigest = aws([
  "ecr",
  "describe-images",
  "--repository-name",
  "view-show-ingestion",
  "--image-ids",
  "imageTag=rnf-d5339f3-20261006",
]).imageDetails[0].imageDigest;
const apiImage = `${account}.dkr.ecr.us-east-1.amazonaws.com/view-show-iac-api@${apiDigest}`;
const workerImage = `${account}.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@${workerDigest}`;
function env(source, overrides, excluded = []) {
  const values = Object.fromEntries(
    (source.environment || [])
      .filter((v) => !excluded.includes(v.name))
      .map((v) => [v.name, v.value]),
  );
  return Object.entries({ ...values, ...overrides }).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}
const namespace = resources.namespace;
const apiEnv = env(
  originalApi,
  {
    OPERATIONAL_TABLE_NAME: resources.operationalTable,
    KUBERNETES_NAMESPACE: namespace,
    INGESTION_CRONJOB_NAME: "ingestion-sync",
    IMPORT_KUBERNETES_NAMESPACE: resources.importsNamespace,
    IMPORT_KUBERNETES_TEMPLATE: "ingestion-import",
    IMPORT_INGESTION_CONTAINER_NAME: "ingestion",
    IMPORT_BUCKET: resources.bucket,
    IMPORT_CANONICAL_FIRST_ENABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    LOKI_PUSH_URL: "",
    BEDROCK_ENABLED: "false",
    ANALYSIS_QUEUE_URL: "",
    METRICS_ENABLED: "true",
    RATE_LIMIT_PER_MINUTE: "1000000",
  },
  (originalApi.environment || [])
    .filter(
      (v) =>
        v.name.startsWith("IMPORT_INGESTION_") ||
        v.name.startsWith("INGESTION_SCHEDULER_"),
    )
    .map((v) => v.name),
);
const workerEnv = env(
  originalWorker,
  {
    OPERATIONAL_TABLE_NAME: resources.operationalTable,
    ARCHIVE_BUCKET: resources.bucket,
    ARCHIVE_BUCKET_OWNER: account,
    GLUE_DATABASE: resources.glueDatabase,
    ATHENA_WORKGROUP: resources.athenaWorkgroup,
    ATHENA_OUTPUT_LOCATION: resources.athenaOutput,
    ANALYSIS_QUEUE_URL: resources.analysisQueueUrl,
    METRICS_NAMESPACE: "view-show/RNF_EKS",
    LOG_SERVICE_NAME: "view-show-ingestion",
    ACTIVATE_CANDIDATE: "false",
  },
  ["IMPORT_ID", "IMPORT_PIPELINE_VERSION", "MYSQL_PASSWORD"],
);
const privateDir = path.join(root, ".artifacts/rnf-eks-private");
mkdirSync(privateDir, { recursive: true });
chmodSync(privateDir, 0o700);
const secretName = "view-show-rnf-eks/mysql";
const describe = spawnSync(
  "aws",
  [
    "secretsmanager",
    "describe-secret",
    "--secret-id",
    secretName,
    "--region",
    "us-east-1",
    "--output",
    "json",
  ],
  { encoding: "utf8" },
);
let selector;
if (describe.status === 0) {
  const value = JSON.parse(describe.stdout);
  if (
    !value.Tags?.some(
      (t) => t.Key === "Purpose" && t.Value === "rnf-synthetic-tests",
    )
  )
    throw Error("MySQL secret ownership mismatch");
  selector = value.ARN;
} else if (describe.stderr?.includes("ResourceNotFoundException")) {
  const input = path.join(privateDir, "mysql-secret-request.json");
  writeFileSync(
    input,
    JSON.stringify({
      Name: secretName,
      SecretString: randomBytes(32).toString("hex"),
      Tags: [
        { Key: "Purpose", Value: "rnf-synthetic-tests" },
        { Key: "Owner", Value: "g05-artifact" },
      ],
    }),
    { mode: 0o600 },
  );
  selector = aws([
    "secretsmanager",
    "create-secret",
    "--cli-input-json",
    "file://" + input,
  ]).ARN;
} else throw Error("Unable to inspect the MySQL secret");
const mysql = {
  name: "mysql-snapshot",
  image: originalMysql.image,
  args: originalMysql.command,
  env: [{ name: "MYSQL_DATABASE", value: "argus" }],
  secrets: [{ name: "MYSQL_ROOT_PASSWORD", valueFrom: selector }],
};
const worker = {
  name: "ingestion",
  image: workerImage,
  args: ["import-dump"],
  env: workerEnv,
  secrets: [{ name: "MYSQL_PASSWORD", valueFrom: selector }],
};
const snapshot = { cpu: "2048", memory: "8192", containers: [mysql, worker] };
const batch = (args) => ({
  cpu: "1024",
  memory: "2048",
  containers: [
    {
      name: "ingestion",
      image: workerImage,
      args,
      env: workerEnv
        .filter(
          (v) =>
            !v.name.startsWith("MYSQL_") &&
            ![
              "ARGUS_SOURCE_MODE",
              "INGESTION_DISK_BUDGET_BYTES",
              "INCREMENTAL_BATCH_QUEUE_URL",
              "LIVE_SYNC_ENABLED",
            ].includes(v.name),
        )
        .concat([
          {
            name: "INCREMENTAL_BATCH_QUEUE_URL",
            value: resources.incrementalQueueUrl,
          },
          { name: "INGESTION_DISK_BUDGET_BYTES", value: "17179869184" },
          { name: "LIVE_SYNC_ENABLED", value: "false" },
        ]),
      secrets: [],
    },
  ],
});
const backfill = structuredClone(snapshot);
backfill.containers.find((c) => c.name === "ingestion").args = ["backfill"];
const config = {
  iam_mode: "learner-lab-existing",
  cluster_name: cluster.name,
  cluster_arn: cluster.arn,
  region: "us-east-1",
  namespace,
  vpc_id: cluster.resourcesVpcConfig.vpcId,
  target_group_arn: edge.targetGroupArn,
  target_group_security_group: edge.securityGroupId,
  node_security_group: cluster.resourcesVpcConfig.clusterSecurityGroupId,
  system_roles: {},
  workload_roles: {},
  api_min_replicas: 1,
  api_max_replicas: 4,
  api_replicas: 1,
  api_cpu_target: 50,
  analysis_enabled: false,
  analysis_replicas: 0,
  sync_enabled: false,
  incremental_enabled: false,
  snapshot_storage_gib: 192,
  log_retention_days: 7,
  observability: null,
  workloads: {
    api: {
      cpu: "256",
      memory: "512",
      containers: [
        { name: "api", image: apiImage, args: [], env: apiEnv, secrets: [] },
      ],
    },
    "ingestion-import": snapshot,
    "ingestion-backfill": backfill,
    "ingestion-sync": batch(["sync"]),
    "ingestion-incremental-export": batch(["export-incremental"]),
    "ingestion-incremental-ingest": batch([
      "ingest-incremental",
      "--limit",
      "20",
    ]),
    "analysis-worker": {
      cpu: "512",
      memory: "1024",
      containers: [
        {
          name: "analysis-worker",
          image: "unused-disabled",
          args: [],
          env: [],
          secrets: [],
        },
      ],
    },
  },
};
writeFileSync(path.join(privateDir, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
const sanitized = structuredClone(config);
for (const workload of Object.values(sanitized.workloads))
  for (const c of workload.containers)
    for (const v of c.env)
      if (/SECRET|PASSWORD/.test(v.name)) v.value = "[REDACTED]";
writeFileSync(
  path.join(out, "deployment-contract-redacted.json"),
  JSON.stringify(sanitized, null, 2) + "\n",
);
writeFileSync(
  path.join(out, "images.json"),
  JSON.stringify(
    {
      codeRevision: "d5339f3de35a42d633f6b3de91e5c919b1c6d57c",
      buildPlatform: "linux/amd64",
      apiImage,
      workerImage,
      mysqlImage: mysql.image,
      runnerSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      configurationScope:
        "dedicated EKS and data; production renderer/controller versions; all schedules suspended; no analysis/Bedrock; HTTP ALB excludes Amplify/API Gateway",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Private deployment contract prepared; redacted contract and exact digests preserved",
);

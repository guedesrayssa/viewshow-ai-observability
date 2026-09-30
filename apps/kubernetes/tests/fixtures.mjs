const snapshot = {
  cpu: "2048",
  memory: "8192",
  containers: [
    {
      name: "mysql-snapshot",
      image: "mysql:8.4",
      args: ["mysqld"],
      env: [{ name: "MYSQL_DATABASE", value: "argus" }],
      secrets: [
        {
          name: "MYSQL_ROOT_PASSWORD",
          valueFrom:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot",
        },
      ],
    },
    {
      name: "ingestion",
      image: "ingestion@sha256:" + "a".repeat(64),
      args: ["import-dump"],
      env: [{ name: "ACTIVATE_CANDIDATE", value: "false" }],
      secrets: [
        {
          name: "MYSQL_PASSWORD",
          valueFrom:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot",
        },
      ],
    },
  ],
};
const batch = (args) => ({
  cpu: "1024",
  memory: "2048",
  containers: [
    {
      name: "ingestion",
      image: "ingestion:stable",
      args,
      env: [],
      secrets: [],
    },
  ],
});
export const config = {
  namespace: "view-show",
  region: "us-east-1",
  cluster_name: "view-show-cluster",
  cluster_arn: "arn:aws:eks:us-east-1:123456789012:cluster/view-show-cluster",
  vpc_id: "vpc-example",
  target_group_arn:
    "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api/1234567890abcdef",
  target_group_security_group: "sg-1234567890abcdef0",
  api_min_replicas: 1,
  api_max_replicas: 4,
  api_replicas: 1,
  api_cpu_target: 60,
  analysis_enabled: true,
  sync_enabled: false,
  incremental_enabled: false,
  workload_roles: Object.fromEntries(
    [
      "api",
      "analysis-worker",
      "ingestion-import",
      "ingestion-backfill",
      "ingestion-sync",
      "ingestion-incremental-export",
      "ingestion-incremental-ingest",
    ].map((name) => [name, `arn:aws:iam::123456789012:role/${name}`]),
  ),
  workloads: {
    api: {
      cpu: "512",
      memory: "1024",
      containers: [
        {
          name: "api",
          image: "api:stable",
          args: [],
          env: [
            { name: "AUTH_COOKIE_SECRET", value: "test-cookie-secret" },
            { name: "AWS_REGION", value: "us-east-1" },
          ],
          secrets: [],
        },
      ],
    },
    "ingestion-import": snapshot,
    "ingestion-backfill": snapshot,
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
          image: "analysis:stable",
          args: [],
          env: [],
          secrets: [],
        },
      ],
    },
  },
};

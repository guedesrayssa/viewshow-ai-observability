import { test } from "node:test";
import assert from "node:assert/strict";
import { render, secretSelector } from "../render.mjs";
import { snapshotJob } from "../run-job.mjs";
import { config } from "./fixtures.mjs";
const rendered = await render(config, async () => "test-password");
const find = (kind, name) =>
  rendered.resources.find((r) => r.kind === kind && r.metadata.name === name);
test("snapshot workers await MySQL and can complete independently of sidecar", () => {
  const pod = find("CronJob", "ingestion-import").spec.jobTemplate.spec.template
    .spec;
  assert.equal(pod.initContainers[0].restartPolicy, "Always");
  assert.ok(pod.initContainers[0].startupProbe);
  assert.equal(pod.containers.length, 1);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.securityContext.fsGroup, 10001);
  assert.equal(
    find("CronJob", "ingestion-import").spec.jobTemplate.spec.backoffLimit,
    0,
  );
});
test("api has probes, resources, ALB binding and autoscaling", () => {
  const api = find("Deployment", "api").spec.template.spec.containers[0];
  assert.equal(api.readinessProbe.httpGet.path, "/health");
  assert.ok(api.startupProbe);
  assert.ok(api.livenessProbe);
  assert.equal(api.resources.requests.cpu, "500m");
  assert.equal(
    find("TargetGroupBinding", "api").spec.targetGroupARN,
    config.target_group_arn,
  );
  assert.equal(find("HorizontalPodAutoscaler", "api").spec.maxReplicas, 4);
});
test("schedules preserve frequencies, remain suspended, and forbid overlap", () => {
  for (const [name, schedule] of [
    ["ingestion-sync", "*/15 * * * *"],
    ["ingestion-incremental-export", "*/15 * * * *"],
    ["ingestion-incremental-ingest", "*/5 * * * *"],
  ]) {
    const cron = find("CronJob", name);
    assert.equal(cron.spec.schedule, schedule);
    assert.equal(cron.spec.suspend, true);
    assert.equal(cron.spec.concurrencyPolicy, "Forbid");
  }
});
test("API secret values never enter Pod plaintext env or ConfigMaps", () => {
  const api = find("Deployment", "api").spec.template.spec.containers[0];
  assert.deepEqual(api.env[0], {
    name: "AUTH_COOKIE_SECRET",
    valueFrom: { secretKeyRef: { name: "api-env", key: "AUTH_COOKIE_SECRET" } },
  });
  assert.equal(
    find("Secret", "api-env").stringData.AUTH_COOKIE_SECRET,
    "test-cookie-secret",
  );
});
test("import RBAC is isolated to import namespace without secret access", () => {
  const role = find("Role", "import-launcher");
  assert.equal(role.metadata.namespace, "view-show-imports");
  assert.ok(role.rules.every((r) => !r.resources.includes("secrets")));
  assert.equal(
    find("ServiceAccount", "ingestion-import").metadata.namespace,
    "view-show-imports",
  );
});
test("Secrets Manager selectors are checked", () => {
  assert.deepEqual(
    secretSelector(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:password::",
    ),
    {
      arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:live",
      key: "password",
    },
  );
  assert.throws(() => secretSelector("bad"));
});
test("manual backfill pins snapshot, has independent secret and never activates", () => {
  const snapshot = {
    bucket: "bucket",
    key: "dumps/a.sql.gz",
    versionId: "v1",
    sha256: "a".repeat(64),
    snapshotExtractedOn: "2026-09-30",
    size: 123,
  };
  const runbook = {
    namespace: "view-show",
    cluster_name: "cluster",
    storage: { bucket: "bucket" },
  };
  const first = snapshotJob(
    find("CronJob", "ingestion-backfill"),
    snapshot,
    runbook,
    "attempt-1",
  );
  const second = snapshotJob(
    find("CronJob", "ingestion-backfill"),
    snapshot,
    runbook,
    "attempt-1",
  );
  assert.equal(first.metadata.name, second.metadata.name);
  assert.notEqual(
    first.metadata.name,
    snapshotJob(
      find("CronJob", "ingestion-backfill"),
      snapshot,
      runbook,
      "attempt-2",
    ).metadata.name,
  );
  const pod = first.spec.template.spec;
  assert.equal(
    pod.containers[0].env.find((v) => v.name === "ACTIVATE_CANDIDATE").value,
    "false",
  );
  assert.equal(
    pod.containers[0].env.find((v) => v.name === "MYSQL_PASSWORD").valueFrom
      .secretKeyRef.name,
    `${first.metadata.name}-mysql`,
  );
  assert.throws(() =>
    snapshotJob(
      find("CronJob", "ingestion-backfill"),
      { ...snapshot, versionId: "null" },
      runbook,
      "attempt",
    ),
  );
});

test("missing live credentials are allowed only while the schedule is suspended", async () => {
  const input = structuredClone(config);
  input.workloads["ingestion-sync"].containers[0].secrets = [
    {
      name: "LIVE_MYSQL_PASSWORD",
      valueFrom:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:password::",
    },
  ];
  const output = await render(input, async ({ arn, optional }) => {
    if (arn.endsWith(":live")) {
      assert.equal(optional, true);
      return undefined;
    }
    return "snapshot-password";
  });
  assert.equal(
    output.resources.some(
      (r) => r.kind === "Secret" && r.metadata.name === "ingestion-sync-env",
    ),
    false,
  );
  const cron = output.resources.find(
    (r) => r.kind === "CronJob" && r.metadata.name === "ingestion-sync",
  );
  assert.equal(cron.spec.suspend, true);
  assert.equal(
    cron.spec.jobTemplate.spec.template.spec.containers[0].env[0].valueFrom
      .secretKeyRef.name,
    "ingestion-sync-env",
  );
  input.sync_enabled = true;
  await assert.rejects(
    render(input, async ({ arn }) =>
      arn.endsWith(":live") ? undefined : "snapshot-password",
    ),
    /Missing required secret/,
  );
});

test("Academy uses node credentials while retaining Kubernetes service accounts/RBAC", async () => {
  const lab = structuredClone(config);
  lab.iam_mode = "learner-lab-existing";
  lab.workload_roles = {};
  const output = await render(lab, async () => "test-password");
  for (const serviceAccount of output.resources.filter(
    (r) => r.kind === "ServiceAccount",
  ))
    assert.equal(
      serviceAccount.metadata.annotations?.["eks.amazonaws.com/role-arn"],
      undefined,
    );
  const api = output.resources.find(
    (r) => r.kind === "Deployment" && r.metadata.name === "api",
  );
  assert.equal(api.spec.template.spec.serviceAccountName, "api");
  const pod = output.resources.find(
    (r) => r.kind === "CronJob" && r.metadata.name === "ingestion-import",
  ).spec.jobTemplate.spec.template.spec;
  assert.equal(pod.containers[0].resources.requests.cpu, "500m");
  assert.equal(pod.initContainers[0].resources.requests.cpu, "500m");
  assert.equal(pod.containers[0].resources.limits.cpu, "1000m");
  assert.equal(
    api.spec.template.spec.containers[0].env.find(
      (v) => v.name === "AWS_EC2_METADATA_DISABLED",
    ).value,
    "false",
  );
  assert.equal(
    find("Deployment", "api").spec.template.spec.containers[0].env.find(
      (v) => v.name === "AWS_EC2_METADATA_DISABLED",
    ).value,
    "true",
  );
});

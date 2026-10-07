#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const directory = dirname(fileURLToPath(import.meta.url));
export function snapshotJob(template, snapshot, runbook, attempt) {
  if (
    snapshot.bucket !== runbook.storage.bucket ||
    !snapshot.key?.startsWith("dumps/") ||
    !snapshot.versionId ||
    snapshot.versionId === "null" ||
    !/^[a-f0-9]{64}$/.test(snapshot.sha256) ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size < 1 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshotExtractedOn) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(attempt)
  )
    throw new Error("Invalid pinned snapshot or launch attempt.");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        cluster: runbook.cluster_name,
        snapshot: {
          bucket: snapshot.bucket,
          key: snapshot.key,
          versionId: snapshot.versionId,
          sha256: snapshot.sha256,
          size: snapshot.size,
          snapshotExtractedOn: snapshot.snapshotExtractedOn,
        },
        attempt,
      }),
    )
    .digest("hex");
  const name = `backfill-${fingerprint.slice(0, 32)}`;
  const spec = structuredClone(template.spec.jobTemplate.spec);
  if (spec.template.spec.serviceAccountName !== "ingestion-backfill")
    throw new Error("Invalid backfill template identity.");
  const worker = spec.template.spec.containers.find(
    (c) => c.name === "ingestion",
  );
  const mysql = spec.template.spec.initContainers?.find(
    (c) => c.name === "mysql-snapshot",
  );
  if (!worker || mysql?.restartPolicy !== "Always")
    throw new Error(
      "Backfill template requires worker and native MySQL sidecar.",
    );
  worker.args = [
    "backfill",
    "--run-id",
    `ingestion-${fingerprint.slice(0, 54)}`,
  ];
  const overrides = {
    SNAPSHOT_BUCKET: snapshot.bucket,
    SNAPSHOT_OBJECT_KEY: snapshot.key,
    SNAPSHOT_OBJECT_VERSION_ID: snapshot.versionId,
    SNAPSHOT_SHA256: snapshot.sha256,
    SNAPSHOT_EXTRACTED_ON: snapshot.snapshotExtractedOn,
    ACTIVATE_CANDIDATE: "false",
  };
  worker.env = [
    ...worker.env.filter((v) => !(v.name in overrides)),
    ...Object.entries(overrides).map(([name, value]) => ({ name, value })),
  ];
  // An independent password per Job removes cross-run secret rotation races.
  for (const container of [mysql, worker])
    for (const variable of container.env)
      if (["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"].includes(variable.name))
        variable.valueFrom = {
          secretKeyRef: { name: `${name}-mysql`, key: "password" },
        };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: runbook.namespace,
      labels: {
        "app.kubernetes.io/name": "ingestion-backfill",
        "view-show/snapshot": snapshot.sha256.slice(0, 63),
      },
    },
    spec,
  };
}
function command(program, args, input, optional = false) {
  const r = spawnSync(program, args, {
    input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || (!optional && r.status !== 0))
    throw new Error(`${program} failed (exit ${r.status}).`);
  return r;
}
export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2)
    throw new Error(
      "Usage: node apps/kubernetes/run-job.mjs SNAPSHOT_EVIDENCE.json LAUNCH_ATTEMPT",
    );
  const runbook = JSON.parse(
    command("terraform", [
      `-chdir=${resolve(directory, "../fullstack")}`,
      "output",
      "-json",
      "kubernetes_runbook",
    ]).stdout,
  );
  const cluster = command("kubectl", [
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={.contexts[0].context.cluster}",
  ]).stdout;
  const awsIdentity = JSON.parse(
    command("aws", ["sts", "get-caller-identity", "--output", "json"]).stdout,
  );
  if (
    !cluster.includes(
      `:eks:${runbook.region}:${awsIdentity.Account}:cluster/${runbook.cluster_name}`,
    )
  )
    throw new Error(
      "AWS identity and selected Kubernetes cluster differ from Terraform.",
    );
  const kubectl = (args, input, optional) =>
    command("kubectl", ["-n", runbook.namespace, ...args], input, optional);
  for (const cron of [
    "ingestion-sync",
    "ingestion-incremental-export",
    "ingestion-incremental-ingest",
  ]) {
    const schedule = JSON.parse(
      kubectl(["get", "cronjob", cron, "-o", "json"]).stdout,
    );
    if (!schedule.spec.suspend)
      throw new Error("Suspend live CronJobs before manual snapshot backfill.");
  }
  const snapshot = JSON.parse(readFileSync(argv[0], "utf8"));
  const template = JSON.parse(
    kubectl(["get", "cronjob", "ingestion-backfill", "-o", "json"]).stdout,
  );
  const job = snapshotJob(template, snapshot, runbook, argv[1]);
  const head = JSON.parse(
    command("aws", [
      "s3api",
      "head-object",
      "--bucket",
      snapshot.bucket,
      "--key",
      snapshot.key,
      "--version-id",
      snapshot.versionId,
      "--expected-bucket-owner",
      awsIdentity.Account,
      "--region",
      runbook.region,
      "--output",
      "json",
    ]).stdout,
  );
  if (
    head.ContentLength !== snapshot.size ||
    head.Metadata?.sha256 !== snapshot.sha256
  )
    throw new Error("S3 object does not match the pinned snapshot.");
  const existing = kubectl([
    "get",
    "job",
    job.metadata.name,
    "--ignore-not-found",
    "-o",
    "json",
  ]).stdout;
  if (existing.trim()) {
    const previous = JSON.parse(existing);
    if (
      JSON.stringify(previous.spec.template.spec.containers[0].args) !==
      JSON.stringify(job.spec.template.spec.containers[0].args)
    )
      throw new Error("Conflicting backfill Job.");
    console.log(
      `${runbook.namespace}/${job.metadata.name} already exists; use a new attempt for an intentional retry.`,
    );
    return;
  }
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: `${job.metadata.name}-mysql`,
      namespace: runbook.namespace,
    },
    type: "Opaque",
    stringData: { password: randomBytes(48).toString("base64url") },
  };
  // A retry may encounter the Secret created before a failed Job submission.
  const currentSecret = kubectl([
    "get",
    "secret",
    secret.metadata.name,
    "--ignore-not-found",
    "-o",
    "name",
  ]).stdout;
  if (!currentSecret.trim())
    kubectl(["create", "-f", "-"], JSON.stringify(secret));
  const created = JSON.parse(
    kubectl(["create", "-f", "-", "-o", "json"], JSON.stringify(job)).stdout,
  );
  kubectl([
    "patch",
    "secret",
    secret.metadata.name,
    "--type=merge",
    "-p",
    JSON.stringify({
      metadata: {
        ownerReferences: [
          {
            apiVersion: "batch/v1",
            kind: "Job",
            name: created.metadata.name,
            uid: created.metadata.uid,
          },
        ],
      },
    }),
  ]);
  console.log(
    `Created ${runbook.namespace}/${job.metadata.name}. Activation remains false.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

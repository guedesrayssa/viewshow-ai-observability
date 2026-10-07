import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  "aws",
  ["configure", "export-credentials", "--format", "process"],
  { encoding: "utf8" },
);
if (result.status !== 0) throw Error("AWS credential provider failed");
const c = JSON.parse(result.stdout);
const root = "http://127.0.0.1:13002";
const headers = {
  "Content-Type": "application/json",
  Authorization:
    "Basic " + Buffer.from("lab:local-rnf-only").toString("base64"),
};
async function call(endpoint, body) {
  const response = await fetch(root + endpoint, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(`Grafana ${response.status}: ${data.message}`);
  return data;
}
const credentials =
  "[default]\naws_access_key_id=" +
  c.AccessKeyId +
  "\naws_secret_access_key=" +
  c.SecretAccessKey +
  "\naws_session_token=" +
  c.SessionToken +
  "\n";
const injected = spawnSync(
  "docker",
  [
    "compose",
    "-f",
    path.join(dir, "compose.yml"),
    "exec",
    "-T",
    "--user",
    "root",
    "grafana",
    "sh",
    "-c",
    "mkdir -p /home/grafana/.aws /usr/share/grafana/.aws; chmod 700 /home/grafana/.aws /usr/share/grafana/.aws; umask 077; cat > /home/grafana/.aws/credentials; cp /home/grafana/.aws/credentials /usr/share/grafana/.aws/credentials; chown -R 472:0 /home/grafana/.aws /usr/share/grafana/.aws",
  ],
  { encoding: "utf8", input: credentials },
);
if (injected.status !== 0)
  throw Error("Cannot configure ephemeral Grafana AWS SDK credentials");
const ds = {
  name: "CloudWatch RNF AWS",
  uid: "rnf-cloudwatch",
  type: "cloudwatch",
  access: "proxy",
  jsonData: { authType: "default", defaultRegion: "us-east-1" },
};
const existing = await fetch(root + "/api/datasources/uid/rnf-cloudwatch", {
  headers,
});
if (existing.ok) {
  const response = await fetch(root + "/api/datasources/uid/rnf-cloudwatch", {
    method: "PUT",
    headers,
    body: JSON.stringify(ds),
  });
  if (!response.ok) throw Error("Cannot update CloudWatch credentials");
} else await call("/api/datasources", ds);
const d = JSON.parse(
  readFileSync(path.join(dir, "provisioning/dashboards/rnf-aws.json"), "utf8"),
);
d.panels = d.panels.slice(0, 4);
const template = readFileSync(
  path.resolve(
    dir,
    "../../../../fullstack/observability/aws/view-show-ingestion.json.tftpl",
  ),
  "utf8",
);
let rendered = template
  .replaceAll("${metrics_namespace}", "view-show/Ingestion")
  .replaceAll("${aws_region}", "us-east-1")
  .replaceAll("${deployment_namespace}", "view-show")
  .replaceAll("${cluster_name}", "view-show-iac-cluster")
  .replaceAll("${ingestion_import_family}", "view-show-ingestion-import")
  .replaceAll("${ingestion_backfill_family}", "view-show-ingestion-backfill")
  .replaceAll("${ingestion_sync_family}", "view-show-ingestion-sync")
  .replaceAll(
    "${ingestion_incremental_ingest_family}",
    "view-show-ingestion-incremental-ingest",
  )
  .replaceAll(
    "${ingestion_incremental_export_family}",
    "view-show-ingestion-incremental-export",
  )
  .replaceAll(
    "${incremental_queue_name}",
    "view-show-ingestion-incremental-batches.fifo",
  )
  .replaceAll(
    "${incremental_dlq_name}",
    "view-show-ingestion-incremental-batches-dlq.fifo",
  )
  .replaceAll("$${operation:text}", "import-dump")
  .replaceAll("$${operation:value}", "view-show-ingestion-import")
  .replaceAll("$${operation}", "import-dump");
const values = {
  account_id: "239162056821",
  analysis_queue: "view-show-ingestion-analysis",
  analysis_dlq: "view-show-ingestion-analysis-dlq",
  incremental_queue: "view-show-ingestion-incremental-batches.fifo",
  incremental_dlq: "view-show-ingestion-incremental-batches-dlq.fifo",
  backfill_log_group: "/ecs/view-show-ingestion-backfill",
  sync_log_group: "/ecs/view-show-ingestion-sync",
  incremental_export_log_group: "/ecs/view-show-ingestion-incremental-export",
  incremental_ingest_log_group: "/ecs/view-show-ingestion-incremental-ingest",
  backfill_task_family: "view-show-ingestion-backfill",
  sync_task_family: "view-show-ingestion-sync",
  incremental_export_task_family: "view-show-ingestion-incremental-export",
  incremental_ingest_task_family: "view-show-ingestion-incremental-ingest",
};
for (const [name, value] of Object.entries(values))
  rendered = rendered.replaceAll("${" + name + "}", value);
rendered = rendered.replaceAll("$operation", "view-show-ingestion-import");
// Keep unresolved template fields visible as errors, rather than publish invalid dashboards.
const unresolved = rendered.match(/\$\{[^}]+\}/g);
if (unresolved)
  throw Error(
    "Unresolved dashboard template fields: " +
      [...new Set(unresolved)].join(", "),
  );
const worker = JSON.parse(rendered);
for (const panel of worker.panels.slice(0, 4)) {
  panel.id = d.panels.length + 1;
  panel.gridPos.y = 8;
  panel.title = "Worker AWS — " + panel.title;
  panel.datasource.uid = "rnf-cloudwatch";
  for (const target of panel.targets)
    if (target.datasource) target.datasource.uid = "rnf-cloudwatch";
  d.panels.push(panel);
}
d.description =
  "Coleta da conta 239162056821, us-east-1. API: Prometheus; worker import-dump: CloudWatch. Ausência de amostra não é zero. CPU da API é por processo; CPU do worker é utilizada/reservada.";
writeFileSync(
  path.join(dir, "provisioning/dashboards/rnf-aws.json"),
  JSON.stringify(d, null, 2) + "\n",
);
// The file provider reloads this file; provisioned dashboards are immutable via API.
const installed = await call("/api/dashboards/uid/" + d.uid);
if (!installed.dashboard) throw Error("Dashboard not provisioned");
console.log(
  "CloudWatch data source and dashboard provisioned; temporary credentials confined to the Grafana container, never the repository.",
);

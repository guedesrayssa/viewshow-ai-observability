import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(
  testDirectory,
  "..",
  "observability",
  "aws",
  "view-show-ingestion.json.tftpl",
);

const fixture = Object.freeze({
  account_id: "123456789012",
  aws_region: "us-east-1",
  metrics_namespace: "view-show/Ingestion",
  cluster_name: "view-show-iac-cluster",
  backfill_task_family: "view-show-ingestion-backfill",
  sync_task_family: "view-show-ingestion-sync",
  incremental_export_task_family: "view-show-ingestion-incremental-export",
  incremental_ingest_task_family: "view-show-ingestion-incremental-ingest",
  analysis_queue: "view-show-ingestion-analysis",
  analysis_dlq: "view-show-ingestion-analysis-dlq",
  incremental_queue: "view-show-ingestion-incremental-batches.fifo",
  incremental_dlq: "view-show-ingestion-incremental-batches-dlq.fifo",
  backfill_log_group: "/ecs/view-show-ingestion-backfill",
  sync_log_group: "/ecs/view-show-ingestion-sync",
  incremental_export_log_group: "/ecs/view-show-ingestion-incremental-export",
  incremental_ingest_log_group: "/ecs/view-show-ingestion-incremental-ingest",
});

function renderDashboard() {
  const operationTextMarker = "__GRAFANA_OPERATION_TEXT__";
  let rendered = readFileSync(templatePath, "utf8").replaceAll(
    "$${operation:text}",
    operationTextMarker,
  );
  for (const [key, value] of Object.entries(fixture)) {
    rendered = rendered.replaceAll(`\${${key}}`, value);
  }
  rendered = rendered.replaceAll(operationTextMarker, "${operation:text}");
  return JSON.parse(rendered);
}

function panelByTitle(dashboard, title) {
  const panel = dashboard.panels.find((candidate) => candidate.title === title);
  assert.ok(panel, `missing panel: ${title}`);
  return panel;
}

test("Grafana text variables remain escaped for Terraform template rendering", () => {
  const template = readFileSync(templatePath, "utf8");
  assert.match(template, /\$\$\{operation:text\}/);
  assert.doesNotMatch(template, /(?<!\$)\$\{operation:text\}/);
});

test("throughput uses read and write terminal metrics with valid fixed-period math", () => {
  const panel = panelByTitle(renderDashboard(), "Throughput — registros/s");
  const rawMetrics = panel.targets.filter((target) => target.metricName);
  assert.deepEqual(
    rawMetrics.map((target) => target.metricName).sort(),
    ["RecordsRead", "RecordsWritten"],
  );
  assert.ok(panel.targets.some((target) => target.expression === "SUM(records_read)/300"));
  assert.ok(panel.targets.some((target) => target.expression === "SUM(records_written)/300"));
});

test("metric math never calls PERIOD on CloudWatch search results", () => {
  const expressions = renderDashboard().panels
    .flatMap((panel) => panel.targets ?? [])
    .map((target) => target.expression)
    .filter(Boolean);
  assert.ok(expressions.length > 0);
  assert.ok(expressions.every((expression) => !/\bPERIOD\s*\(/.test(expression)));
});

test("all metric-math targets use Grafana Search Code mode and execution defaults", () => {
  const targets = renderDashboard().panels
    .flatMap((panel) => panel.targets ?? [])
    .filter((target) => target.queryMode === "Metrics" && target.expression);
  assert.equal(targets.length, 5);
  for (const target of targets) {
    // Grafana filters Insights queries without SQL before running metric math.
    // The backend also requires statistic even when expression supplies the data.
    assert.deepEqual(
      Object.fromEntries(
        ["metricQueryType", "metricEditorMode", "dimensions", "metricName", "namespace", "period", "statistic"]
          .map((key) => [key, target[key]]),
      ),
      {
        metricQueryType: 0,
        metricEditorMode: 1,
        dimensions: {},
        metricName: "",
        namespace: "",
        period: "300",
        statistic: "Average",
      },
      target.id,
    );
    assert.notEqual(target.hide, true, `${target.id} must remain visible`);
  }
});

test("error rates use the same explicit 300 second period", () => {
  const panel = panelByTitle(renderDashboard(), "Erros por segundo");
  assert.ok(
    panel.targets.some(
      (target) => target.expression === "(SUM(failed_runs)+SUM(partial_runs))/300",
    ),
  );
  assert.ok(
    panel.targets.some((target) => target.expression === "SUM(rejected_records)/300"),
  );
});

test("one operation selector correlates command text and ECS task family", () => {
  const dashboard = renderDashboard();
  assert.deepEqual(dashboard.templating.list.map((variable) => variable.name), ["operation"]);
  assert.deepEqual(
    dashboard.templating.list[0].options.map(({ text, value }) => [text, value]),
    [
      ["backfill", fixture.backfill_task_family],
      ["sync", fixture.sync_task_family],
      ["export-incremental", fixture.incremental_export_task_family],
      ["ingest-incremental", fixture.incremental_ingest_task_family],
    ],
  );

  const commandTargets = dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .filter((target) => target.dimensions?.command !== undefined);
  assert.ok(commandTargets.length > 0);
  for (const target of commandTargets) {
    // Grafana only expands scalar dimension variables; arrays pass through literally.
    assert.equal(target.dimensions.command, "${operation:text}");
  }

  const cpu = panelByTitle(dashboard, "CPU da task — utilizada/reservada");
  for (const target of cpu.targets.filter((candidate) => candidate.metricName)) {
    assert.equal(target.dimensions.TaskDefinitionFamily, "$operation");
  }
});

test("panel ids and target refIds are unique", () => {
  const dashboard = renderDashboard();
  assert.equal(new Set(dashboard.panels.map((panel) => panel.id)).size, dashboard.panels.length);
  for (const panel of dashboard.panels) {
    const refIds = (panel.targets ?? []).map((target) => target.refId);
    assert.equal(new Set(refIds).size, refIds.length, `duplicate refId in ${panel.title}`);
    assert.equal(panel.datasource?.uid, "cloudwatch");
  }
});

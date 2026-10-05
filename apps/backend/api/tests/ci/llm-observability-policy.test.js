const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const observabilityRoot = path.join(repositoryRoot, "apps/fullstack/observability");
const dashboardPath = path.join(observabilityRoot, "grafana/provisioning/dashboards/json/view-show-agentic.json");
const awsDashboardPath = path.join(observabilityRoot, "aws/view-show-agentic-aws.json.tftpl");
const overviewPath = path.join(observabilityRoot, "grafana/provisioning/dashboards/json/view-show-overview.json");
const rulesPath = path.join(observabilityRoot, "prometheus/rules/view-show.yml");
const runbookPath = path.join(observabilityRoot, "docs/runbooks/agentic-high-failure-rate.md");
const observabilityTerraformPath = path.join(repositoryRoot, "apps/fullstack/observability-aws.tf");
const userDataPath = path.join(observabilityRoot, "aws/user-data.sh.tftpl");
const userDataValidatorPath = path.join(observabilityRoot, "aws/validate-user-data.sh");

test("agentic dashboard uses the approved metrics and local datasources", () => {
  const dashboardText = fs.readFileSync(dashboardPath, "utf8");
  const dashboard = JSON.parse(dashboardText);
  assert.equal(dashboard.uid, "view-show-agentic");
  const datasources = new Set(dashboard.panels.map((panel) => panel.datasource?.type));
  assert.ok(datasources.has("prometheus"));
  assert.ok(datasources.has("tempo"));
  assert.ok(datasources.has("loki"));
  for (const metric of [
    "analysis_messages_total",
    "analysis_run_duration_seconds",
    "llm_requests_total",
    "llm_request_duration_seconds",
    "llm_tokens_total",
    "llm_response_stop_total",
  ]) assert.match(dashboardText, new RegExp(metric));
});

test("observability artifacts exclude sensitive and obsolete vocabulary", () => {
  const artifacts = [dashboardPath, awsDashboardPath, overviewPath, rulesPath, runbookPath]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  for (const forbidden of [
    "bedrock_invocation",
    "prompt",
    "systemPrompt",
    "userPrompt",
    "response.text",
    "evidence",
    "password",
    "senha",
  ]) assert.doesNotMatch(artifacts, new RegExp(forbidden.replace(".", "\\."), "i"));
});

test("AWS agentic dashboard preserves metrics and traces while using CloudWatch for logs", () => {
  const dashboardText = fs.readFileSync(awsDashboardPath, "utf8");
  const rendered = dashboardText
    .replaceAll("${aws_region}", "us-east-1")
    .replaceAll("${aws_account_id}", "111122223333")
    .replaceAll("${analysis_worker_log_group}", "/ecs/view-show-analysis-worker");
  const dashboard = JSON.parse(rendered);
  assert.equal(dashboard.uid, "view-show-agentic-aws");
  assert.equal(dashboard.panels.length, 8);
  for (const metric of [
    "analysis_messages_total",
    "analysis_run_duration_seconds",
    "llm_requests_total",
    "llm_request_duration_seconds",
    "llm_tokens_total",
    "llm_response_stop_total",
  ]) assert.match(dashboardText, new RegExp(metric));
  assert.match(dashboardText, /histogram_quantile\(0\.50/);
  assert.match(dashboardText, /histogram_quantile\(0\.95/);
  assert.match(dashboardText, /histogram_quantile\(0\.99/);
  assert.ok(dashboard.panels.some((panel) => panel.datasource?.type === "tempo" && panel.type === "traces"));
  const logs = dashboard.panels.find((panel) => panel.type === "logs");
  assert.equal(logs.datasource.type, "cloudwatch");
  assert.equal(logs.targets[0].region, "us-east-1");
  assert.equal(logs.targets[0].logGroups[0].name, "/ecs/view-show-analysis-worker");
  assert.match(logs.targets[0].expression, /fields @timestamp, event, eventType, code, terminal, @message/);
  for (const forbidden of ["OLLAMA_BASE_URL", "ollama_base_url", "username", "password"]) {
    assert.doesNotMatch(dashboardText, new RegExp(forbidden, "i"));
  }
});

test("AWS cloud-init packages and validates the rendered agentic dashboard", () => {
  const terraform = fs.readFileSync(observabilityTerraformPath, "utf8");
  const userData = fs.readFileSync(userDataPath, "utf8");
  const validator = fs.readFileSync(userDataValidatorPath, "utf8");
  assert.match(terraform, /view-show-agentic-aws\.json\.tftpl/);
  assert.match(terraform, /analysis_worker_log_group\s*=\s*"\/ecs\/\$\{var\.deployment_namespace\}-analysis-worker"/);
  assert.match(terraform, /agentic_dashboard_gzip\s*=\s*base64gzip\(local\.agentic_dashboard_aws\)/);
  assert.match(userData, /view-show-agentic-aws\.json/);
  assert.match(userData, /\$\{agentic_dashboard_gzip\}/);
  assert.match(validator, /view-show-agentic-aws\.json/);
  assert.match(validator, /AGENTIC_DASHBOARD_GZIP/);
});

test("overview and alert link to the generic LLM observability contract", () => {
  const overview = fs.readFileSync(overviewPath, "utf8");
  const rules = fs.readFileSync(rulesPath, "utf8");
  assert.match(overview, /llm_request_duration_seconds_bucket/);
  assert.doesNotMatch(overview, /bedrock_invocation_duration_seconds_bucket/);
  assert.match(overview, /view-show-agentic/);
  assert.match(rules, /alert:\s*ViewShowLlmHighFailureRate/);
  assert.match(rules, /llm_requests_total\{status="failure"\}/);
  assert.match(rules, /runbook:\s*apps\/fullstack\/observability\/docs\/runbooks\/agentic-high-failure-rate\.md/);
  assert.equal(fs.existsSync(runbookPath), true);
});

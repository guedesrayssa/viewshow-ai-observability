const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const observabilityRoot = path.join(repositoryRoot, "apps/fullstack/observability");
const dashboardPath = path.join(observabilityRoot, "grafana/provisioning/dashboards/json/view-show-agentic.json");
const overviewPath = path.join(observabilityRoot, "grafana/provisioning/dashboards/json/view-show-overview.json");
const rulesPath = path.join(observabilityRoot, "prometheus/rules/view-show.yml");
const runbookPath = path.join(observabilityRoot, "docs/runbooks/agentic-high-failure-rate.md");

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
  const artifacts = [dashboardPath, overviewPath, rulesPath, runbookPath]
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

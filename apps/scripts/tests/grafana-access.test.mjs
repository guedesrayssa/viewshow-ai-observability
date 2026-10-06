import assert from "node:assert/strict";
import test from "node:test";

import {
  grafanaHealthShellCommand,
  readGrafanaHealthInvocation,
  readOllamaConfiguration,
} from "../lib/grafana-access.mjs";

test("Grafana health command checks containers, CloudWatch and both dashboards without printing the password", () => {
  const command = grafanaHealthShellCommand();
  assert.match(command, /grafana.*prometheus.*loki.*tempo.*alloy/s);
  assert.match(command, /api\/datasources\/uid\/cloudwatch\/health/);
  assert.match(command, /api\/dashboards\/uid\/view-show-ingestion/);
  assert.match(command, /api\/dashboards\/uid\/view-show-agentic-aws/);
  assert.doesNotMatch(command, /echo.*GRAFANA_ADMIN_PASSWORD/);
});

test("Grafana health invocation accepts only the exact success sentinel", () => {
  assert.deepEqual(readGrafanaHealthInvocation({
    Status: "Success",
    StandardOutputContent: "GRAFANA_READY CLOUDWATCH_READY DASHBOARDS=view-show-ingestion,view-show-agentic-aws\n",
    StandardErrorContent: "",
  }), {
    grafana: "READY",
    cloudwatch: "READY",
    dashboards: ["view-show-ingestion", "view-show-agentic-aws"],
  });
  assert.throws(
    () => readGrafanaHealthInvocation({ Status: "Failed" }),
    /health check failed/,
  );
});

test("Ollama configuration status never claims connectivity", () => {
  assert.equal(readOllamaConfiguration(null), "NOT_CONFIGURED");
  assert.equal(readOllamaConfiguration({ modelId: "qwen2.5:7b" }), "CONFIGURED");
  assert.equal(readOllamaConfiguration({}), "NOT_CONFIGURED");
});

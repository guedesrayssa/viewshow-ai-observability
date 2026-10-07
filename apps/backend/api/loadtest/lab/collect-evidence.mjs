import { validatePanel } from "./observability-contract.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const out = path.resolve(process.env.RESULTS_DIR || "results/observability");
mkdirSync(out, { recursive: true });
const start = process.env.START_UTC || "2026-10-06T23:06:00Z";
const end = process.env.END_UTC || new Date().toISOString();
const prometheusUrl = process.env.PROMETHEUS_URL || "http://127.0.0.1:19090";
const auth = "Basic " + Buffer.from("lab:local-rnf-only").toString("base64");
const dashboard = JSON.parse(readFileSync(process.argv[2], "utf8"));
const checks = [];
for (const panel of dashboard.panels) {
  const request = {
    from: String(Date.parse(start)),
    to: String(Date.parse(end)),
    queries: panel.targets.map((target) => ({
      ...target,
      datasource: target.datasource || panel.datasource,
      intervalMs: 5000,
      maxDataPoints: 1200,
      ...(panel.datasource.type === "prometheus" ? { range: true } : {}),
    })),
  };
  const response = await fetch("http://127.0.0.1:13002/api/ds/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  writeFileSync(
    path.join(out, `grafana-panel-${panel.id}.json`),
    JSON.stringify(data, null, 2) + "\n",
  );
  checks.push(validatePanel(panel, response.status, data));
}
const targets = await fetch(prometheusUrl + "/api/v1/targets").then((r) =>
  r.json(),
);
writeFileSync(
  path.join(out, "prometheus-targets.json"),
  JSON.stringify(targets, null, 2) + "\n",
);
for (const panel of dashboard.panels.filter(
  (p) => p.datasource.type === "prometheus",
)) {
  const query = panel.targets[0].expr;
  const response = await fetch(
    prometheusUrl + "/api/v1/query_range?" +
      new URLSearchParams({
        query,
        start: String(Date.parse(start) / 1000),
        end: String(Date.parse(end) / 1000),
        step: "5",
      }),
  ).then((r) => r.json());
  writeFileSync(
    path.join(out, `prometheus-panel-${panel.id}.json`),
    JSON.stringify({ query, start, end, ...response }, null, 2) + "\n",
  );
}
const report = {
  start,
  end,
  dashboardUid: dashboard.uid,
  checks,
  passed: checks.every((c) => c.passed),
};
writeFileSync(
  path.join(out, "observability-validation.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;

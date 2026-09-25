import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { parseAnalysisEvent } from "../src/contracts/analysis-event.js";
import { validateWindow } from "../src/worker/orchestrator.js";

const root = resolve(process.cwd(), "contracts/fixtures");
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(resolve(root, name), "utf8"));

for (const name of ["anomaly-detection.v1.json", "qoe-forecast.v1.json", "reanalysis-requested.v1.json"]) {
  test(`fixture ${name} satisfaz o contrato executável`, async () => {
    const parsed = parseAnalysisEvent(await load(name));
    assert.ok(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.metadata.failures));
    if (parsed.ok && parsed.event.eventType !== "REANALYSIS_REQUESTED") {
      const event = parsed.event;
      assert.doesNotThrow(() => validateWindow(event));
    }
  });
}

test("fixture de fato contém a identidade e a métrica mínimas", async () => {
  const fact = await load("time-series-fact.v1.json") as Record<string, any>;
  assert.match(fact.pk, /^DATASET#[^#]+#FACT#TS#[^#]+#\d{8}$/);
  assert.match(fact.sk, /^T#\d+#.+$/);
  assert.equal(typeof fact.recordId, "string");
  assert.equal(typeof fact.seriesId, "string");
  assert.equal(typeof fact.observedAt, "string");
  assert.ok(Number.isFinite(Date.parse(fact.observedAt)));
  assert.equal(typeof fact.payload?.metric?.name, "string");
  assert.equal(typeof fact.payload?.metric?.unit, "string");
  assert.ok(fact.payload.metric.value === null || typeof fact.payload.metric.value === "number");
});

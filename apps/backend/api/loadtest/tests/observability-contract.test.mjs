import test from "node:test";
import assert from "node:assert/strict";
import { validatePanel } from "../lab/observability-contract.mjs";
const series = (values) => ({
  frames: [
    {
      schema: { fields: [{ type: "time" }, { type: "number" }] },
      data: { values: [[1, 2], values] },
    },
  ],
});
test("hidden inputs cannot approve a missing displayed expression", () => {
  const panel = {
    id: 4,
    title: "CPU",
    targets: [{ refId: "A", hide: true }, { refId: "C" }],
  };
  assert.equal(
    validatePanel(panel, 200, {
      results: { A: series([10, 20]), C: series([]) },
    }).passed,
    false,
  );
});
test("both displayed throughput series require real samples", () => {
  const panel = {
    id: 2,
    title: "Throughput",
    targets: [{ refId: "A" }, { refId: "B" }],
  };
  assert.equal(
    validatePanel(panel, 200, {
      results: { A: series([1, 2]), B: series([null, null]) },
    }).passed,
    false,
  );
});
test("collected zeros are valid; numeric-looking strings and timestamps are not", () => {
  const panel = { id: 3, title: "Errors", targets: [{ refId: "A" }] };
  assert.equal(
    validatePanel(panel, 200, { results: { A: series([0, 0]) } }).passed,
    true,
  );
  assert.equal(
    validatePanel(panel, 200, { results: { A: series(["0", "0"]) } }).passed,
    false,
  );
  assert.equal(
    validatePanel(panel, 403, { results: { A: series([0, 0]) } }).passed,
    false,
  );
});
test("any datasource error rejects the panel even if a frame exists", () => {
  const panel = { id: 1, title: "Latency", targets: [{ refId: "A" }] };
  assert.equal(
    validatePanel(panel, 200, {
      results: { A: { ...series([1, 2]), error: "AWS dimensions invalid" } },
    }).passed,
    false,
  );
});

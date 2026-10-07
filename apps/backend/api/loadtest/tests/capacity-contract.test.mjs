import test from "node:test";
import assert from "node:assert/strict";
import { processingBudgetSeconds } from "../lab/capacity-contract.mjs";
test("capacity budget preserves 10k/min across all planned volumes", () => {
  for (const [events, seconds] of [
    [150000, 900],
    [300000, 1800],
    [750000, 4500],
  ]) {
    const budget = processingBudgetSeconds(events);
    assert.equal(budget, seconds);
    assert.equal((events / budget) * 60, 10000);
  }
});
test("unknown volume cannot receive an arbitrary passing budget", () => {
  for (const value of [undefined, 0, -1, NaN, 1.5])
    assert.throws(() => processingBudgetSeconds(value));
  assert.throws(() => processingBudgetSeconds(750000, 0));
  assert.equal(processingBudgetSeconds(750000, 900), 900); // Deliberate stricter stress budget is explicit.
});

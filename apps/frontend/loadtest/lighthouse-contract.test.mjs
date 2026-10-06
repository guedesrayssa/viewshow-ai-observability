import test from "node:test";
import assert from "node:assert/strict";
import { validateLighthouseReport } from "./lighthouse-contract.mjs";

const names = ["first-contentful-paint", "largest-contentful-paint", "speed-index", "total-blocking-time", "cumulative-layout-shift"];
const valid = () => ({ audits: Object.fromEntries(names.map((name, index) => [name, { numericValue: index < 3 ? 100 : 0 }])) });

test("an errored LCP audit cannot be promoted to an accepted sample", () => {
  const report = valid();
  report.audits["largest-contentful-paint"] = { scoreDisplayMode: "error", errorMessage: "NO_LCP" };
  assert.throws(() => validateLighthouseReport(report), /NO_LCP/);
});
test("missing metrics fail while real zero TBT/CLS remain valid", () => {
  assert.doesNotThrow(() => validateLighthouseReport(valid()));
  const report = valid();
  delete report.audits["first-contentful-paint"];
  assert.throws(() => validateLighthouseReport(report), /ausente/);
});

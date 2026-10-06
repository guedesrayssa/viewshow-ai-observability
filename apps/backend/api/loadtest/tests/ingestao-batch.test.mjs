import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as contract from "../k6/lib/ingestion-contract.mjs";

/** Loads the actual k6 script with in-memory HTTP/metrics; no account is contacted. */
function load(changes = {}, httpOverrides = {}) {
  const samples = new Map();
  class Metric {
    constructor(name) { this.name = name; samples.set(name, []); }
    add(value) { samples.get(this.name).push(value); }
  }
  const source = fs.readFileSync(new URL("../k6/ingestao-batch.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export default function/gm, "function iteration")
    .replace(/^export /gm, "");
  const context = {
    __ENV: { BASE_URL: "http://local.invalid", MODE: "smoke", DUMP: "fixture", ...changes },
    open: () => new ArrayBuffer(8),
    http: { setResponseCallback() {}, expectedStatuses() {}, ...httpOverrides },
    crypto: { sha256: () => "a".repeat(64) },
    Counter: Metric, Rate: Metric, Trend: Metric,
    check: (subject, checks) => Object.values(checks).every((check) => check(subject)),
    sleep() {}, exec: {}, console,
    forgeSessionCookie: () => "test-cookie", requestIdHeader: () => ({}),
    ...contract,
  };
  vm.runInNewContext(source + "\nglobalThis.api = { options, track, setup, teardown, handleSummary };", context);
  return { ...context.api, samples };
}

test("limiter fails when no throttling was observed and arrival-rate discards are checked", () => {
  const subject = load({ MODE: "limite" });
  assert.deepEqual(Array.from(subject.options.thresholds["rate_limited_429{fase:rajada}"]), ["count>0"]);
  assert.deepEqual(Array.from(subject.options.thresholds.dropped_iterations), ["count==0"]);
  assert.deepEqual(Array.from(load({ MODE: "pico" }).options.thresholds.dropped_iterations), ["count==0"]);
});

test("both recognized and unknown 503 responses count against availability", () => {
  const subject = load();
  subject.track({ status: 503, json: () => "UPLOAD_PREPARATION_FAILED" });
  subject.track({ status: 503, json: () => "SOME_OTHER_ERROR" });
  assert.deepEqual(subject.samples.get("unexpected_5xx"), [1, 1]);
  assert.deepEqual(subject.samples.get("explicit_503"), [1]);
});

test("capacity test requires a known fresh volume and idempotent recovery a known version", () => {
  assert.throws(() => load({ MODE: "drenagem" }), /EXPECTED_EVENTS/);
  assert.throws(() => load({ ALLOW_IDEMPOTENT: "true" }), /EXPECTED_VERSION/);
  assert.throws(() => load({ POLL_TIMEOUT_S: "NaN" }), /POLL_TIMEOUT_S/);
  assert.throws(() => load({ MODE: "frescor", T0: "invalid", EXPECT_OBSERVED_THROUGH: "invalid" }), /timestamps/);
});

test("cleanup never completes a preexisting import", () => {
  let getCalled = false;
  const subject = load({ MODE: "limite" }, {
    post: () => ({ status: 409, json: (path) => ({ "error.code": "IMPORT_IN_PROGRESS", "error.details.importId": "imp-other" })[path] }),
    get: () => { getCalled = true; throw new Error("must not touch other import"); },
  });
  const setup = subject.setup();
  assert.equal(setup.createdByUs, false);
  subject.teardown(setup);
  assert.equal(getCalled, false);
});

test("peak cleanup excludes uploads reserved by the same user before this run", () => {
  let calls = 0;
  const subject = load({ MODE: "pico" }, {
    get: () => {
      calls += 1;
      return { json: () => [{ state: "UPLOADING", canManageUpload: true, importId: "imp-before", createdAt: new Date(0).toISOString() }] };
    },
  });
  subject.teardown(subject.setup());
  assert.equal(calls, 1);
});

test("summary records reproducible parameters while redacting the cookie", () => {
  const subject = load({ EXPECTED_EVENTS: "150000" });
  const outputs = subject.handleSummary({ metrics: {}, root_group: { checks: [], groups: [] }, setup_data: { cookie: "secret-cookie" } });
  const stored = JSON.parse(outputs["resumo-ingestao-smoke.json"]);
  assert.equal(stored.setup_data.cookie, "<redigido>");
  assert.equal(stored.test_config.expectedEvents, 150000);
  assert.equal(stored.test_config.dumpSha256, "a".repeat(64));
});

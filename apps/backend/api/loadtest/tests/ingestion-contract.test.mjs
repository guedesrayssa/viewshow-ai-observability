import test from "node:test";
import assert from "node:assert/strict";
import { controlResponseMatches, hasRecordProgress, isImportConflict, isRateLimited } from "../k6/lib/ingestion-contract.mjs";

function response(status, values = {}) {
  return { status, json: (path) => values[path] };
}

test("conflict proves the active import rather than accepting any 409", () => {
  assert.equal(isImportConflict(response(409)), false);
  assert.equal(isImportConflict(response(409, { "error.code": "CONFLICT", "error.details.importId": "imp-1" })), false);
  const conflict = response(409, { "error.code": "IMPORT_IN_PROGRESS", "error.details.importId": "imp-1" });
  assert.equal(isImportConflict(conflict, "imp-1"), true);
  assert.equal(isImportConflict(conflict, "imp-2"), false);
});

test("overload requires RATE_LIMITED and recovery rejects it", () => {
  const limited = response(429, { "error.code": "RATE_LIMITED" });
  assert.equal(isRateLimited(response(429)), false);
  assert.equal(controlResponseMatches(limited, "GET", "rajada", "imp-1"), true);
  assert.equal(controlResponseMatches(limited, "GET", "recuperacao", "imp-1"), false);
});

test("a 401, 404 or 503 cannot pass the resilience scenario", () => {
  for (const status of [401, 404, 503]) {
    for (const phase of ["nominal", "rajada", "resfriamento", "recuperacao"]) {
      assert.equal(controlResponseMatches(response(status), "GET", phase, "imp-1"), false);
    }
  }
  assert.equal(controlResponseMatches(response(200, { "data.importId": "imp-1" }), "GET", "recuperacao", "imp-1"), true);
  assert.equal(controlResponseMatches(response(200, { "data.importId": "imp-2" }), "GET", "recuperacao", "imp-1"), false);
});

test("READY without complete counters cannot prove processing or integrity", () => {
  assert.equal(hasRecordProgress(undefined), false);
  assert.equal(hasRecordProgress({ kind: "stage", recordsWritten: 150000 }), false);
  const valid = { kind: "stage", recordsRead: 150000, recordsWritten: 150000, recordsRejected: 0 };
  assert.equal(hasRecordProgress(valid), true);
  assert.equal(hasRecordProgress({ ...valid, recordsRejected: -1 }), false);
  assert.equal(hasRecordProgress({ ...valid, recordsWritten: "150000" }), false);
});

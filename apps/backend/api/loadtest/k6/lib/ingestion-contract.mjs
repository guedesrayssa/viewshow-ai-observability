/** Validates control-plane responses without treating an arbitrary error as backpressure. */
export function responseValue(response, path) {
  try {
    return response.json(path);
  } catch {
    return undefined;
  }
}

/** A conflict must identify the active import; recovery must refer to that same import. */
export function isImportConflict(response, expectedImportId = null) {
  const id = responseValue(response, "error.details.importId");
  return response.status === 409 &&
    responseValue(response, "error.code") === "IMPORT_IN_PROGRESS" &&
    typeof id === "string" && id.length > 0 &&
    (!expectedImportId || id === expectedImportId);
}

/** Only an explicit RATE_LIMITED response demonstrates the configured limiter. */
export function isRateLimited(response) {
  return response.status === 429 && responseValue(response, "error.code") === "RATE_LIMITED";
}

/** Tests GET availability and POST backpressure; 429 is permitted only during overload. */
export function controlResponseMatches(response, method, phase, importId) {
  if (phase === "rajada" || phase === "resfriamento") {
    if (isRateLimited(response)) return true;
  }
  if (method === "POST") return isImportConflict(response, importId);
  return response.status === 200 && responseValue(response, "data.importId") === importId;
}

/** READY alone does not prove integrity: require explicit, non-negative record counters. */
export function hasRecordProgress(progress) {
  return Boolean(progress) && progress.kind === "stage" &&
    [progress.recordsRead, progress.recordsWritten, progress.recordsRejected]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
}

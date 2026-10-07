/** A 10,000 events/minute objective scales the processing budget with volume. */
export function processingBudgetSeconds(expectedEvents, explicitBudget) {
  const count = Number(expectedEvents);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Capacity profile requires a positive known event count");
  }
  const seconds =
    explicitBudget === undefined
      ? (count * 60) / 10000
      : Number(explicitBudget);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Invalid processing budget");
  return seconds;
}

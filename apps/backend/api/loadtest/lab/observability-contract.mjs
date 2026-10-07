/** A dashboard passes only when every displayed query has numeric samples. */
export function validatePanel(panel, httpStatus, data) {
  const displayed = panel.targets.filter((target) => !target.hide);
  const queries = displayed.map((target) => {
    const result = data.results?.[target.refId];
    const samples = (result?.frames || []).reduce(
      (sum, frame) =>
        sum +
        (frame.data?.values || []).reduce(
          (n, values, i) =>
            n +
            (frame.schema?.fields?.[i]?.type === "number"
              ? values.filter(Number.isFinite).length
              : 0),
          0,
        ),
      0,
    );
    return { refId: target.refId, samples, error: result?.error || null };
  });
  const errors = Object.values(data.results || {}).flatMap((result) =>
    result.error ? [result.error] : [],
  );
  return {
    panelId: panel.id,
    title: panel.title,
    httpStatus,
    samples: queries.reduce((n, query) => n + query.samples, 0),
    displayedQueries: queries,
    errors,
    passed:
      httpStatus === 200 &&
      displayed.length > 0 &&
      queries.every((query) => query.samples > 0 && !query.error) &&
      errors.length === 0,
  };
}

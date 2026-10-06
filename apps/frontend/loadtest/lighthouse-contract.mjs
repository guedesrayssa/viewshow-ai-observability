/** Missing/error audits are invalid measurements, never successful samples. */
export function validateLighthouseReport(report) {
  if (report.runtimeError) throw new Error(JSON.stringify(report.runtimeError));
  for (const name of ["first-contentful-paint", "largest-contentful-paint", "speed-index", "total-blocking-time", "cumulative-layout-shift"]) {
    const audit = report.audits?.[name];
    if (audit?.scoreDisplayMode === "error" || !Number.isFinite(audit?.numericValue)) {
      throw new Error(`Lighthouse audit ${name} inválido: ${audit?.errorMessage || "valor ausente"}`);
    }
  }
}

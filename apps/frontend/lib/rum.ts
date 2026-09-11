const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export type RumMetricName =
  | "frontend_web_vitals_fcp_seconds"
  | "frontend_web_vitals_lcp_seconds"
  | "frontend_web_vitals_inp_ms"
  | "frontend_web_vitals_cls"
  | "frontend_client_errors_total"
  | "frontend_api_fetch_errors_total"
  | "operator_clicks_to_root_cause";

type RumUnit = "seconds" | "milliseconds" | "score" | "count";

const units: Record<RumMetricName, RumUnit> = {
  frontend_web_vitals_fcp_seconds: "seconds",
  frontend_web_vitals_lcp_seconds: "seconds",
  frontend_web_vitals_inp_ms: "milliseconds",
  frontend_web_vitals_cls: "score",
  frontend_client_errors_total: "count",
  frontend_api_fetch_errors_total: "count",
  operator_clicks_to_root_cause: "count",
};

export function normalizedPath(pathname = window.location.pathname): string {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments[0]}`;
}

export function reportRum(
  name: RumMetricName,
  value: number,
  options: {
    metricId?: string;
    rating?: "good" | "needs-improvement" | "poor";
  } = {},
): void {
  if (typeof window === "undefined" || !Number.isFinite(value) || value < 0)
    return;
  const base = new URL(API_BASE_URL.trim() || "/", window.location.origin);
  base.pathname =
    `${base.pathname.replace(/\/$/, "")}/api/v1/telemetry/rum`.replace(
      /\/{2,}/g,
      "/",
    );
  const body = JSON.stringify({
    schemaVersion: 1,
    name,
    value,
    unit: units[name],
    metricId: options.metricId,
    path: normalizedPath(),
    navigationType: (
      performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined
    )?.type,
    occurredAt: new Date().toISOString(),
    rating: options.rating,
  });
  const payload = new Blob([body], { type: "application/json" });
  const queued =
    typeof navigator.sendBeacon === "function" &&
    navigator.sendBeacon(base, payload);
  if (!queued) {
    void fetch(base, {
      method: "POST",
      body: payload,
      credentials: "include",
      keepalive: true,
    }).catch(() => {
      // Telemetry must never disrupt the user flow.
    });
  }
}

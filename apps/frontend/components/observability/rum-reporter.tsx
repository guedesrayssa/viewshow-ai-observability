"use client";

import { useEffect } from "react";
import { onCLS, onFCP, onINP, onLCP, type Metric } from "web-vitals";

import { normalizedPath, reportRum, type RumMetricName } from "@/lib/rum";

let webVitalsStarted = false;

function reportWebVital(name: RumMetricName, divisor = 1) {
  return (metric: Metric) =>
    reportRum(name, metric.value / divisor, {
      metricId: metric.id,
      rating: metric.rating,
    });
}

function startWebVitals(): void {
  if (webVitalsStarted) return;
  webVitalsStarted = true;
  onFCP(reportWebVital("frontend_web_vitals_fcp_seconds", 1_000));
  onLCP(reportWebVital("frontend_web_vitals_lcp_seconds", 1_000));
  onINP(reportWebVital("frontend_web_vitals_inp_ms"));
  onCLS(reportWebVital("frontend_web_vitals_cls"));
}

export function RumReporter() {
  useEffect(() => {
    startWebVitals();
    let clicks = 0;

    const onError = () => reportRum("frontend_client_errors_total", 1);
    const onUnhandledRejection = () =>
      reportRum("frontend_client_errors_total", 1);
    const onClick = (event: MouseEvent) => {
      if (normalizedPath() !== "/incidentes") return;
      clicks += 1;
      const element = event.target instanceof Element ? event.target : null;
      const href = element?.closest("a")?.getAttribute("href") ?? "";
      if (href.startsWith("/evidencias")) {
        reportRum("operator_clicks_to_root_cause", clicks);
        clicks = 0;
      }
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}

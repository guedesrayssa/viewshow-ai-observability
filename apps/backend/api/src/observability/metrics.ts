import type { RequestHandler } from "express";
import type { RumTelemetry } from "@view-show/contracts";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export class Metrics {
  readonly registry = new Registry();
  private readonly requests = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["service_name", "method", "route", "status_code"],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["service_name", "method", "route", "status_code"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
    registers: [this.registry],
  });
  private readonly failed = new Counter({
    name: "http_requests_failed_total",
    help: "Total HTTP requests completed with a 4xx or 5xx status",
    labelNames: ["service_name", "method", "route", "status_code"],
    registers: [this.registry],
  });
  private readonly responseSize = new Histogram({
    name: "http_response_size_bytes",
    help: "HTTP response size in bytes",
    labelNames: ["service_name", "route"],
    buckets: [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576],
    registers: [this.registry],
  });
  private readonly inflight = new Gauge({
    name: "http_requests_in_flight",
    help: "In-flight HTTP requests",
    labelNames: ["service_name", "method", "route"],
    registers: [this.registry],
  });
  private readonly hypothesisReviews = new Counter({
    name: "hypothesis_review_submissions_total",
    help: "Submitted operator verdicts for incident hypotheses",
    labelNames: ["service_name", "verdict"],
    registers: [this.registry],
  });
  private readonly rumHistograms: ReadonlyMap<string, Histogram<string>> =
    new Map(
      (
        [
          [
            "frontend_web_vitals_fcp_seconds",
            "Frontend First Contentful Paint in seconds",
            [0.5, 1, 1.8, 2.5, 3, 4, 6, 10, 30, 60],
          ],
          [
            "frontend_web_vitals_lcp_seconds",
            "Frontend Largest Contentful Paint in seconds",
            [0.5, 1, 1.5, 2.5, 3, 4, 6, 10, 30, 60],
          ],
          [
            "frontend_web_vitals_inp_ms",
            "Frontend Interaction to Next Paint in milliseconds",
            [50, 100, 200, 300, 500, 800, 1_000, 2_000, 5_000, 60_000],
          ],
          [
            "frontend_web_vitals_cls",
            "Frontend Cumulative Layout Shift score",
            [0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10],
          ],
          [
            "operator_clicks_to_root_cause",
            "Clicks required to open root-cause evidence",
            [1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100],
          ],
        ] as const
      ).map(
        ([name, help, buckets]) =>
          [
            name,
            new Histogram({
              name,
              help,
              labelNames: ["service_name", "path", "rating"],
              buckets: [...buckets],
              registers: [this.registry],
            }),
          ] as const,
      ),
    );
  private readonly rumCounters: ReadonlyMap<string, Counter<string>> = new Map(
    (
      [
        ["frontend_client_errors_total", "Unhandled frontend errors"],
        ["frontend_api_fetch_errors_total", "Failed frontend API requests"],
      ] as const
    ).map(
      ([name, help]) =>
        [
          name,
          new Counter({
            name,
            help,
            labelNames: ["service_name", "path"],
            registers: [this.registry],
          }),
        ] as const,
    ),
  );

  constructor(private readonly serviceName: string) {
    collectDefaultMetrics({ register: this.registry, prefix: "view_show_" });
  }

  middleware(): RequestHandler {
    return (request, response, next) => {
      if (request.path === "/health" || request.path === "/metrics")
        return next();
      const started = process.hrtime.bigint();
      this.inflight.inc({
        service_name: this.serviceName,
        method: request.method,
        route: "pending",
      });
      response.once("finish", () => {
        const route = `${request.baseUrl}${typeof request.route?.path === "string" ? request.route.path : "unmatched"}`;
        const labels = {
          service_name: this.serviceName,
          method: request.method,
          route,
          status_code: String(response.statusCode),
        };
        this.requests.inc(labels);
        if (response.statusCode >= 400) this.failed.inc(labels);
        this.duration.observe(
          labels,
          Number(process.hrtime.bigint() - started) / 1_000_000_000,
        );
        const contentLength = Number(response.getHeader("content-length"));
        if (Number.isFinite(contentLength))
          this.responseSize.observe(
            { service_name: this.serviceName, route },
            contentLength,
          );
        this.inflight.dec({
          service_name: this.serviceName,
          method: request.method,
          route: "pending",
        });
      });
      next();
    };
  }

  observeRum(
    name: RumTelemetry["name"],
    value: number,
    path: string,
    rating?: string,
  ): void {
    const labels = { service_name: "view-show-frontend", path };
    const counter = this.rumCounters.get(name);
    if (counter) {
      counter.inc(labels, value);
      return;
    }
    this.rumHistograms
      .get(name)
      ?.observe({ ...labels, rating: rating ?? "unknown" }, value);
  }

  observeHypothesisReview(
    verdict: "confirmed" | "refuted" | "inconclusive",
  ): void {
    this.hypothesisReviews.inc({
      service_name: this.serviceName,
      verdict,
    });
  }
}

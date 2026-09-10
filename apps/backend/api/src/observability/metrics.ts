import type { RequestHandler } from "express";
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
  private readonly inflight = new Gauge({
    name: "http_requests_in_flight",
    help: "In-flight HTTP requests",
    labelNames: ["service_name", "method", "route"],
    registers: [this.registry],
  });

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
        this.duration.observe(
          labels,
          Number(process.hrtime.bigint() - started) / 1_000_000_000,
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
}

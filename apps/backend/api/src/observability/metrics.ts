import type { RequestHandler } from "express";
import { TraceFlags, trace } from "@opentelemetry/api";
import {
  getLogTransportStats,
  resolveServiceMetadata,
  type RumTelemetry,
} from "@view-show/contracts";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type OpenMetricsContentType,
} from "prom-client";

/** Resultado de uma tentativa de login por senha (cardinalidade fechada). */
const LOGIN_OUTCOMES = [
  "success",
  "invalid_credentials",
  "blocked",
  "rate_limited",
  "unavailable",
  "error",
] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

export class Metrics {
  /**
   * Formato OpenMetrics: é o único que carrega exemplares. O Prometheus
   * negocia o formato pelo cabeçalho `Accept`, então a coleta segue igual.
   */
  readonly registry = Metrics.createRegistry();
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
    // A cauda vai até 60 s de propósito. Com o teto anterior de 10 s o
    // histogram_quantile saturava exatamente na faixa que interessa sob
    // sobrecarga (as rodadas em ECS Fargate mediram p95 entre 17 s e 43 s),
    // e o painel de latência do Grafana passava a mentir em platô.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 15, 20, 30, 45, 60],
    // Cada amostra amostrada guarda o trace_id: do pico no gráfico ao trace.
    enableExemplars: true,
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
  private readonly loginAttempts = new Counter({
    name: "auth_login_attempts_total",
    help: "Password login attempts by outcome (brute force signal, RNF04)",
    labelNames: ["service_name", "outcome"],
    registers: [this.registry],
  });
  private readonly buildInfo = new Gauge({
    name: "view_show_build_info",
    help: "Running build; always 1. Correlate latency and errors with deploys",
    labelNames: ["service_name", "version", "environment"],
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

  private static createRegistry(): Registry<OpenMetricsContentType> {
    const registry = new Registry<OpenMetricsContentType>();
    registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    return registry;
  }

  constructor(private readonly serviceName: string) {
    collectDefaultMetrics({ register: this.registry, prefix: "view_show_" });
    const metadata = resolveServiceMetadata(serviceName);
    this.buildInfo.set(
      {
        service_name: serviceName,
        version: metadata.version,
        environment: metadata.environment,
      },
      1,
    );
    // Séries em zero desde o início: sem amostra o Prometheus não tem série, e
    // o painel mostraria "No data" em vez de 0.
    for (const outcome of LOGIN_OUTCOMES)
      this.loginAttempts.inc({ service_name: serviceName, outcome }, 0);
    this.registerLogShippingMetrics();
  }

  /**
   * A saúde do envio de logs ao Loki é uma métrica: sem ela, uma falha do
   * transporte (best-effort por desenho) seria invisível justo quando se
   * precisa dos logs.
   */
  private registerLogShippingMetrics(): void {
    const labels = { service_name: this.serviceName };
    const delta = (read: () => number) => {
      let last = 0;
      return (counter: Counter<"service_name">) => {
        const current = read();
        if (current > last) counter.inc(labels, current - last);
        last = current;
      };
    };
    const track = (name: string, help: string, read: () => number): void => {
      const update = delta(read);
      const counter = new Counter({
        name,
        help,
        labelNames: ["service_name"],
        registers: [this.registry],
        collect() {
          update(this);
        },
      });
      counter.inc(labels, 0);
    };
    track(
      "log_shipping_pushed_lines_total",
      "Log lines delivered to Loki",
      () => getLogTransportStats().pushedLines,
    );
    track(
      "log_shipping_failures_total",
      "Failed Loki push requests (stdout remains the durable log)",
      () => getLogTransportStats().failures,
    );
    track(
      "log_shipping_dropped_lines_total",
      "Log lines dropped before reaching Loki (failure or full buffer)",
      () => getLogTransportStats().droppedLines,
    );
    new Gauge({
      name: "log_shipping_buffered_lines",
      help: "Log lines waiting to be pushed to Loki",
      labelNames: ["service_name"],
      registers: [this.registry],
      collect() {
        this.set(labels, getLogTransportStats().bufferedLines);
      },
    });
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
        const seconds =
          Number(process.hrtime.bigint() - started) / 1_000_000_000;
        const span = trace.getActiveSpan()?.spanContext();
        const sampled =
          span !== undefined &&
          trace.isSpanContextValid(span) &&
          (span.traceFlags & TraceFlags.SAMPLED) !== 0;
        // Com enableExemplars o prom-client exige a forma objeto em todo
        // observe(); a chamada posicional lança TypeError dentro do handler.
        this.duration.observe({
          labels,
          value: seconds,
          // A tipagem do prom-client exige que o exemplar use os labels da
          // métrica; no OpenMetrics ele tem rótulos próprios (trace_id).
          ...(sampled
            ? {
                exemplarLabels: {
                  trace_id: span.traceId,
                  span_id: span.spanId,
                } as never,
              }
            : {}),
        });
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

  observeLogin(outcome: LoginOutcome): void {
    this.loginAttempts.inc({ service_name: this.serviceName, outcome });
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { trace, TraceFlags } from "@opentelemetry/api";
import {
  REDACTED_QUERY_PARAMS,
  annotateServerSpan,
  buildInstrumentationConfig,
  isOperationalProbe,
  isTelemetryExport,
  resetLogTransport,
  resolveServiceMetadata,
  withSpan,
} from "@view-show/contracts";
import { Metrics } from "../src/observability/metrics.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLogTransport();
});

function fakeSpan() {
  const calls = {
    attributes: {} as Record<string, unknown>,
    name: undefined as string | undefined,
  };
  return {
    calls,
    span: {
      setAttribute: (key: string, value: unknown) => {
        calls.attributes[key] = value;
      },
      updateName: (name: string) => {
        calls.name = name;
      },
    } as never,
  };
}

describe("trace configuration", () => {
  it("never exports credential-bearing query params, including OIDC code/state", () => {
    for (const param of [
      "code",
      "state",
      "token",
      "id_token",
      "access_token",
      "refresh_token",
      "password",
      // lista padrão do OpenTelemetry, que não pode regredir
      "sig",
      "Signature",
      "AWSAccessKeyId",
      "X-Goog-Signature",
      "X-Amz-Signature",
      "X-Amz-Credential",
      "X-Amz-Security-Token",
    ])
      expect(REDACTED_QUERY_PARAMS).toContain(param);
    const http =
      buildInstrumentationConfig(undefined)[
        "@opentelemetry/instrumentation-http"
      ];
    expect(http?.redactedQueryParamsServer).toEqual([...REDACTED_QUERY_PARAMS]);
    expect(http?.redactedQueryParams).toEqual([...REDACTED_QUERY_PARAMS]);
  });

  it("does not trace health checks and metric scrapes", () => {
    expect(isOperationalProbe("/health")).toBe(true);
    expect(isOperationalProbe("/metrics?x=1")).toBe(true);
    expect(isOperationalProbe("/api/v1/health-report")).toBe(false);
    expect(isOperationalProbe(undefined)).toBe(false);
    const hook =
      buildInstrumentationConfig(undefined)[
        "@opentelemetry/instrumentation-http"
      ]?.ignoreIncomingRequestHook;
    expect(hook?.({ url: "/health" } as never)).toBe(true);
    expect(hook?.({ url: "/api/v1/incidents?window=1h" } as never)).toBe(false);
  });

  it("does not trace the log export to Loki", () => {
    const url = "http://loki:3100/loki/api/v1/push";
    expect(
      isTelemetryExport(
        { origin: "http://loki:3100", path: "/loki/api/v1/push" },
        url,
      ),
    ).toBe(true);
    expect(
      isTelemetryExport(
        { origin: "http://other:3100", path: "/loki/api/v1/push" },
        url,
      ),
    ).toBe(false);
    expect(
      isTelemetryExport({ origin: "http://loki:3100", path: "/x" }, url),
    ).toBe(false);
    expect(
      isTelemetryExport(
        { origin: "http://loki:3100", path: "/loki/api/v1/push" },
        undefined,
      ),
    ).toBe(false);
  });

  it("names the server span by route template and tags request id and error code", () => {
    const { span, calls } = fakeSpan();
    annotateServerSpan(
      span,
      {
        method: "GET",
        baseUrl: "",
        route: { path: "/api/v1/incidents/:incidentId/events" },
      },
      { locals: { requestId: "req_1", errorCode: "DATA_UNAVAILABLE" } },
    );
    expect(calls.name).toBe("GET /api/v1/incidents/:incidentId/events");
    expect(calls.attributes).toMatchObject({
      "http.route": "/api/v1/incidents/:incidentId/events",
      "viewshow.request_id": "req_1",
      "viewshow.error_code": "DATA_UNAVAILABLE",
    });
  });

  it("leaves outgoing HTTP spans and unmatched routes alone", () => {
    const outgoing = fakeSpan();
    annotateServerSpan(outgoing.span, { method: "POST" }, { locals: {} });
    expect(outgoing.calls.name).toBeUndefined();
    expect(outgoing.calls.attributes).toEqual({});

    const unmatched = fakeSpan();
    annotateServerSpan(
      unmatched.span,
      { method: "GET", baseUrl: "" },
      { locals: { requestId: "req_2" } },
    );
    expect(unmatched.calls.name).toBeUndefined();
    expect(unmatched.calls.attributes).toEqual({
      "viewshow.request_id": "req_2",
    });
  });

  it("disables the noisy Express layers and the SDK-internal HTTP spans", () => {
    const config = buildInstrumentationConfig(undefined);
    expect(
      config["@opentelemetry/instrumentation-express"]?.ignoreLayersType,
    ).toEqual(["middleware", "router"]);
    expect(
      config["@opentelemetry/instrumentation-aws-sdk"]
        ?.suppressInternalInstrumentation,
    ).toBe(true);
  });
});

describe("service metadata", () => {
  it("derives name, version and environment from the same variables for every signal", () => {
    const env = {
      OTEL_SERVICE_NAME: "view-show-api",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment=aws,service.version=6d40f7e2e6b2,cloud.region=us-east-1",
    } as NodeJS.ProcessEnv;
    expect(resolveServiceMetadata("fallback", env)).toMatchObject({
      serviceName: "view-show-api",
      version: "6d40f7e2e6b2",
      environment: "aws",
    });
    expect(
      resolveServiceMetadata("fallback", {
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      serviceName: "fallback",
      version: "dev",
      environment: "production",
    });
  });
});

describe("withSpan", () => {
  it("returns the result and rethrows after recording the failure", async () => {
    await expect(withSpan("demo.ok", {}, async () => 42)).resolves.toBe(42);
    await expect(
      withSpan("demo.fail", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("application metrics", () => {
  it("serves OpenMetrics so exemplars can carry the trace id", async () => {
    const metrics = new Metrics("view-show-api");
    expect(metrics.registry.contentType).toContain("openmetrics-text");
    expect(await metrics.registry.metrics()).toMatch(/# EOF\s*$/);
    metrics.registry.clear();
  });

  it("starts login, build info and log shipping series at zero", async () => {
    vi.stubEnv("SERVICE_VERSION", "test-build");
    const metrics = new Metrics("view-show-api");
    const text = await metrics.registry.metrics();
    for (const outcome of [
      "success",
      "invalid_credentials",
      "blocked",
      "rate_limited",
      "unavailable",
      "error",
    ])
      expect(text).toContain(
        `auth_login_attempts_total{service_name="view-show-api",outcome="${outcome}"} 0`,
      );
    expect(text).toContain("view_show_build_info{");
    expect(text).toContain('version="test-build"');
    expect(text).toContain(
      'log_shipping_failures_total{service_name="view-show-api"} 0',
    );
    expect(text).toContain(
      'log_shipping_buffered_lines{service_name="view-show-api"} 0',
    );
    metrics.observeLogin("invalid_credentials");
    expect(await metrics.registry.metrics()).toContain(
      'auth_login_attempts_total{service_name="view-show-api",outcome="invalid_credentials"} 1',
    );
    metrics.registry.clear();
  });

  async function runRequest(metrics: Metrics): Promise<void> {
    const middleware = metrics.middleware();
    let finish: (() => void) | undefined;
    const response = {
      statusCode: 200,
      once: (_event: string, listener: () => void) => {
        finish = listener;
      },
      getHeader: () => "120",
    };
    middleware(
      {
        path: "/api/v1/incidents",
        method: "GET",
        baseUrl: "",
        route: { path: "/api/v1/incidents" },
      } as never,
      response as never,
      () => undefined,
    );
    finish?.();
  }

  it("records latency without a trace (regression: positional observe throws with exemplars on)", async () => {
    const metrics = new Metrics("view-show-api");
    await runRequest(metrics);
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'http_request_duration_seconds_count{service_name="view-show-api",method="GET",route="/api/v1/incidents",status_code="200"} 1',
    );
    expect(text).not.toMatch(/# \{trace_id=/);
    metrics.registry.clear();
  });

  it("attaches the trace id as an exemplar when the request is sampled", async () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.SAMPLED,
      }),
    } as never);
    const metrics = new Metrics("view-show-api");
    await runRequest(metrics);
    expect(await metrics.registry.metrics()).toMatch(
      /http_request_duration_seconds_bucket\{[^}]*\} \d+ # \{trace_id="4bf92f3577b34da6a3ce929d0e0e4736",span_id="00f067aa0ba902b7"\}/,
    );
    metrics.registry.clear();
  });

  it("does not attach an exemplar for an unsampled trace", async () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.NONE,
      }),
    } as never);
    const metrics = new Metrics("view-show-api");
    await runRequest(metrics);
    expect(await metrics.registry.metrics()).not.toMatch(/# \{trace_id=/);
    metrics.registry.clear();
  });
});

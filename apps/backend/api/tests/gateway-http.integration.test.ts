import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("gateway to internal services over HTTP", () => {
  it("calls an internal service, wraps quality metadata, and keeps physical fields private", async () => {
    const token = "internal-token-at-least-24";
    const internal = express();
    internal.get("/internal/v1/incidents", (request, response) => {
      expect(request.header("x-internal-token")).toBe(token);
      expect(request.header("x-request-id")).toBe("req_integration");
      response.json({
        data: {
          capabilities: {
            filtering: {
              status: "partial",
              supportedDimensions: [],
              supportedFilterSets: [[]],
            },
          },
          items: [],
          impactSeries: {
            metric: "affected_devices",
            unit: "devices",
            bucketSeconds: 900,
            measurement: {
              status: "unknown",
              source: "test",
              coverageRatio: null,
              observedThrough: null,
            },
            points: [],
          },
          facets: {},
          page: { limit: 20, hasMore: false, nextCursor: null },
        },
        quality: {
          window: null,
          partial: true,
          refreshAfterSeconds: 30,
          freshness: [],
          warnings: [{ code: "TEST_PARTIAL", message: "controlled" }],
        },
      });
    });
    const incidentsUrl = await listen(internal);
    const unavailable = await listen(
      express().use((_request, response) =>
        response.status(503).json({
          error: {
            code: "FEATURE_UNAVAILABLE",
            message: "controlled",
            requestId: "req_internal",
          },
        }),
      ),
    );
    const gatewayUrl = await listen(
      createApp({
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        services: {
          incidents: incidentsUrl,
          dashboard: unavailable,
          identity: unavailable,
        },
        internalToken: token,
        timeoutMs: 500,
        frontendOrigins: ["http://frontend.test"],
        metricsEnabled: true,
      }),
    );

    const started = performance.now();
    const response = await fetch(`${gatewayUrl}/api/v1/incidents?window=30m`, {
      headers: {
        "x-request-id": "req_integration",
        origin: "http://frontend.test",
      },
    });
    const elapsed = performance.now() - started;
    const body = (await response.json()) as {
      data: unknown;
      meta: {
        requestId: string;
        partial: boolean;
        warnings: Array<{ code: string }>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      requestId: "req_integration",
      partial: true,
    });
    expect(body.meta.warnings[0]?.code).toBe("TEST_PARTIAL");
    expect(JSON.stringify(body.data)).not.toMatch(
      /"(?:pk|sk|ttl|LastEvaluatedKey)"/,
    );
    expect(elapsed).toBeLessThan(1000);
  });

  it("returns cheap health, stable validation, CORS, and dependency errors", async () => {
    const internal = express().use((_request, response) =>
      response.status(503).json({
        error: {
          code: "DATA_UNAVAILABLE",
          message: "projection missing",
          requestId: "req_internal",
        },
      }),
    );
    const internalUrl = await listen(internal);
    const gatewayUrl = await listen(
      createApp({
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        services: {
          incidents: internalUrl,
          dashboard: internalUrl,
          identity: internalUrl,
        },
        internalToken: "internal-token-at-least-24",
        timeoutMs: 500,
        frontendOrigins: ["http://allowed.test"],
        metricsEnabled: true,
      }),
    );
    expect(await (await fetch(`${gatewayUrl}/health`)).json()).toEqual({
      status: "ok",
    });
    const invalid = await fetch(`${gatewayUrl}/api/v1/incidents?limit=1000`);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as object).toHaveProperty("error.requestId");
    expect(
      (await fetch(`${gatewayUrl}/api/v1/dashboard/overview`)).status,
    ).toBe(503);
    expect(
      (
        await fetch(`${gatewayUrl}/api/v1/incidents`, {
          headers: { origin: "http://forbidden.test" },
        })
      ).status,
    ).toBe(403);
    const metrics = await fetch(`${gatewayUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("http_requests_total");
  });

  it("rejects a successful upstream response whose nested data violates the shared contract", async () => {
    const internal = express();
    internal.get("/internal/v1/incidents", (_request, response) => {
      response.json({
        data: {
          capabilities: {
            filtering: {
              status: "partial",
              supportedDimensions: [],
              supportedFilterSets: [[]],
            },
          },
          items: [{ id: "inc_invalid" }],
          impactSeries: {
            metric: "affected_devices",
            unit: "devices",
            bucketSeconds: 900,
            measurement: {
              status: "unknown",
              source: "test",
              coverageRatio: null,
              observedThrough: null,
            },
            points: [],
          },
          facets: {},
          page: { limit: 20, hasMore: false, nextCursor: null },
        },
        quality: {
          window: null,
          partial: true,
          refreshAfterSeconds: 30,
          freshness: [],
          warnings: [],
        },
      });
    });
    const internalUrl = await listen(internal);
    const gatewayUrl = await listen(
      createApp({
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        services: {
          incidents: internalUrl,
          dashboard: internalUrl,
          identity: internalUrl,
        },
        internalToken: "internal-token-at-least-24",
        timeoutMs: 500,
        frontendOrigins: [],
        metricsEnabled: false,
      }),
    );

    const response = await fetch(`${gatewayUrl}/api/v1/incidents`);
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty(
      "error.code",
      "DATA_UNAVAILABLE",
    );
  });
});

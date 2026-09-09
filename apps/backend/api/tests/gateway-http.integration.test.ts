import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuthModule } from "../src/modules/auth/index.ts";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.ts";
import type { DashboardReadRepository } from "../src/modules/dashboard/ports/dashboard-read-repository.ts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.ts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.ts";
import type { IncidentRepository } from "../src/modules/incidents/ports/incident-repository.ts";

const servers: Server[] = [];
const secret = "x".repeat(32);

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

const emptyIncidentRepository: IncidentRepository = {
  async listBetween() {
    return [];
  },
  async bundle() {
    return { incident: null, children: [] };
  },
  async writeReview() {
    return {};
  },
};

function buildApp(
  overrides: {
    readonly incidents?: IncidentRepository;
    readonly dashboard?: DashboardReadRepository;
    readonly frontendOrigins?: readonly string[];
    readonly metricsEnabled?: boolean;
  } = {},
) {
  const incidents = new IncidentUseCases(
    overrides.incidents ?? emptyIncidentRepository,
    new CursorCodec(secret),
    new UnavailableReviewFeedbackPort(),
  );
  const dashboard = new DashboardQueries(
    overrides.dashboard ?? {
      async latestOverview() {
        return null;
      },
      async latestMonitoring() {
        return null;
      },
    },
    ["argus"],
  );
  return createApp({
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      frontendOrigins: overrides.frontendOrigins ?? ["http://frontend.test"],
      metricsEnabled: overrides.metricsEnabled ?? true,
    },
    incidents,
    dashboard,
    auth: createAuthModule({ AUTH_COOKIE_SECRET: secret, NODE_ENV: "test" }),
  });
}

describe("api monolith over HTTP", () => {
  it("calls a module in-process, wraps quality metadata, and keeps physical fields private", async () => {
    const url = await listen(buildApp());
    const response = await fetch(`${url}/api/v1/incidents?window=30m`, {
      headers: {
        "x-request-id": "req_integration",
        origin: "http://frontend.test",
      },
    });
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
    expect(body.meta.warnings[0]?.code).toBe("IMPACT_MEASUREMENT_UNAVAILABLE");
    expect(JSON.stringify(body.data)).not.toMatch(
      /"(?:pk|sk|ttl|LastEvaluatedKey)"/,
    );
  });

  it("returns cheap health, stable validation, CORS, dependency errors, and metrics", async () => {
    const url = await listen(buildApp({ frontendOrigins: ["http://allowed.test"] }));
    expect(await (await fetch(`${url}/health`)).json()).toEqual({
      status: "ok",
    });
    const invalid = await fetch(`${url}/api/v1/incidents?limit=1000`);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as object).toHaveProperty("error.requestId");
    expect((await fetch(`${url}/api/v1/dashboard/overview`)).status).toBe(503);
    expect(
      (
        await fetch(`${url}/api/v1/incidents`, {
          headers: { origin: "http://forbidden.test" },
        })
      ).status,
    ).toBe(403);
    const metrics = await fetch(`${url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("http_requests_total");
  });

  it("surfaces a module DATA_UNAVAILABLE as a 503 envelope", async () => {
    const url = await listen(buildApp({ frontendOrigins: [], metricsEnabled: false }));
    const response = await fetch(`${url}/api/v1/dashboard/overview`);
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty(
      "error.code",
      "DATA_UNAVAILABLE",
    );
  });
});

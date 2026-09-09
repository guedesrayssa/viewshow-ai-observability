import { describe, expect, it, vi } from "vitest";
import { DashboardQueries } from "../dashboard-query-service/src/application/dashboard-queries.js";
import type { DashboardReadRepository } from "../dashboard-query-service/src/ports/dashboard-read-repository.js";

const now = new Date("2026-01-01T12:00:00Z");

describe("dashboard query service", () => {
  it("reports delayed freshness and partial coverage", async () => {
    const repository: DashboardReadRepository = {
      latestOverview: vi.fn(async () => ({
        data: { kpis: [] },
        observedThrough: "2026-01-01T10:00:00Z",
        coverageRatio: 0.8,
        source: "argus",
      })),
      latestMonitoring: vi.fn(async () => null),
    };
    const result = await new DashboardQueries(
      repository,
      ["argus"],
      () => now,
    ).overview({ window: "30m" });
    expect(result.quality.partial).toBe(true);
    expect(result.quality.freshness[0]).toMatchObject({
      state: "delayed",
      lagSeconds: 7200,
    });
  });

  it("returns explicit 503 when a projection was not published", async () => {
    const repository: DashboardReadRepository = {
      latestOverview: vi.fn(async () => null),
      latestMonitoring: vi.fn(async () => null),
    };
    await expect(
      new DashboardQueries(repository, ["argus"], () => now).overview({
        window: "30m",
      }),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
  });

  it("rejects queue depth because the pipeline is batch", async () => {
    const repository: DashboardReadRepository = {
      latestOverview: vi.fn(async () => null),
      latestMonitoring: vi.fn(async () => null),
    };
    await expect(
      new DashboardQueries(repository, ["argus"], () => now).monitoring({
        window: "15m",
        flowMetric: "queue_depth",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

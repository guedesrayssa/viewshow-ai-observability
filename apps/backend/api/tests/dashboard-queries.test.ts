import { describe, expect, it, vi } from "vitest";
import { DashboardQueries } from "../src/modules/dashboard/application/dashboard-queries.js";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../src/modules/datasets/ports/active-dataset-resolver.js";
import type { DashboardReadRepository } from "../src/modules/dashboard/ports/dashboard-read-repository.js";

const now = new Date("2026-01-01T12:00:00Z");
const activeDataset: ActiveDatasetSnapshot = {
  datasetVersion: `dsv_${"a".repeat(64)}`,
  formulaVersions: {
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
  },
  projectionVersions: {
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
  },
  availableIntervals: {
    live_qoe_hourly: [
      {
        start: "2026-01-01T11:00:00.000Z",
        end: "2026-01-01T12:00:00.000Z",
      },
    ],
  },
  hotFrom: { live_qoe_hourly: "2026-01-01T11:00:00.000Z" },
};

const overviewData = {
  capabilities: {
    filtering: {
      status: "unavailable",
      supportedDimensions: [],
      supportedFilterSets: [],
    },
  },
  kpis: [],
  experienceHealth: {
    metric: "errors_per_minute",
    unit: "errors_per_minute",
    bucketSeconds: 3600,
    baselineValue: null,
    measurement: {
      status: "unknown",
      source: "argus",
      coverageRatio: null,
      observedThrough: null,
    },
    points: [],
    anomalyWindows: [],
  },
  recentIncidents: [],
  facets: {},
} as const;

function resolver(
  value: ActiveDatasetSnapshot | null = activeDataset,
): ActiveDatasetResolver & { readonly resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(async () => value) };
}

function repository(): DashboardReadRepository & {
  readonly activeOverview: ReturnType<typeof vi.fn>;
  readonly latestMonitoring: ReturnType<typeof vi.fn>;
} {
  return {
    activeOverview: vi.fn(async () => ({
      data: overviewData,
      observedThrough: "2026-01-01T12:00:00.000Z",
      coverageRatio: 1,
      source: "argus:live_qoe_hourly",
    })),
    latestMonitoring: vi.fn(async () => {
      throw new Error("legacy monitoring read must stay disconnected");
    }),
  };
}

describe("dashboard queries module", () => {
  it.each([
    { deviceType: "smart-tv" },
    { region: "sudeste" },
    { appVersion: "4.2.1" },
    { search: "buffering" },
  ])(
    "rejects an overview filter without a real projection: %o",
    async (filter) => {
      const storage = repository();
      const active = resolver();

      await expect(
        new DashboardQueries(storage, active, ["argus"], () => now).overview({
          window: "30m",
          ...filter,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: "UNSUPPORTED_FILTER_COMBINATION",
      });
      expect(active.resolve).not.toHaveBeenCalled();
      expect(storage.activeOverview).not.toHaveBeenCalled();
    },
  );

  it("returns the public projection selected by the valid ACTIVE manifest", async () => {
    const storage = repository();
    const active = resolver();
    await expect(
      new DashboardQueries(storage, active, ["argus"], () => now).overview({
        window: "30m",
      }),
    ).resolves.toMatchObject({
      data: overviewData,
      datasetVersion: activeDataset.datasetVersion,
    });
    expect(storage.activeOverview).toHaveBeenCalledWith(activeDataset);
  });

  it("returns 503 when there is no ACTIVE dataset", async () => {
    const storage = repository();
    const active = resolver(null);
    await expect(
      new DashboardQueries(storage, active, ["argus"], () => now).overview({
        window: "30m",
      }),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(storage.activeOverview).not.toHaveBeenCalled();
  });

  it.each([
    { flowMetric: "queue_depth" as const },
    { flowMetric: "processing_latency" as const, worker: "worker-1" },
  ])(
    "rejects an unsupported monitoring selector before storage: %o",
    async (query) => {
      const storage = repository();
      const active = resolver();
      await expect(
        new DashboardQueries(storage, active, ["argus"], () => now).monitoring({
          window: "15m",
          ...query,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: "UNSUPPORTED_FILTER_COMBINATION",
      });
      expect(active.resolve).not.toHaveBeenCalled();
      expect(storage.latestMonitoring).not.toHaveBeenCalled();
    },
  );

  it("returns 503 for monitoring without using the legacy read", async () => {
    const storage = repository();
    const active = resolver();
    await expect(
      new DashboardQueries(storage, active, ["argus"], () => now).monitoring({
        window: "15m",
        flowMetric: "processing_latency",
      }),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });
    expect(active.resolve).toHaveBeenCalledTimes(1);
    expect(storage.latestMonitoring).not.toHaveBeenCalled();
  });
});

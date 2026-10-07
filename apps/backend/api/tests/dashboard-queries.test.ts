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

const measurement = {
  status: "measured" as const,
  source: "argus",
  coverageRatio: 1,
  observedThrough: "2026-01-01T12:00:00.000Z",
};

const monitoringData = {
  capabilities: {
    sourceQuality: { status: "available" },
    pipelineRuntime: {
      status: "partial",
      metrics: {
        ingestionRate: "available",
        processingLatencyP95: "partial",
        queueDepth: "unavailable",
        deadLetterQueue: "unavailable",
      },
      reason: "ANALYSIS_QUEUE_METRICS_UNAVAILABLE",
    },
    geographicMetrics: { status: "unavailable", granularity: "state" },
    filtering: {
      status: "partial",
      supportedDimensions: ["source", "flowMetric"],
      supportedFilterSets: [[], ["source"], ["flowMetric"]],
    },
  },
  kpis: {
    ingestionRate: {
      value: 120,
      unit: "events_per_minute",
      status: "healthy",
      measurement,
    },
    processingLatencyP95: {
      value: 800,
      unit: "ms",
      status: "healthy",
      measurement: { ...measurement, status: "estimated" },
    },
    queueDepth: {
      value: null,
      unit: "messages",
      status: "unknown",
      measurement: { ...measurement, status: "unknown" },
    },
    deadLetterQueue: {
      value: null,
      unit: "messages",
      status: "unknown",
      newInWindow: null,
      measurement: { ...measurement, status: "unknown" },
    },
  },
  flow: {
    metric: "processing_latency",
    unit: "ms",
    bucketSeconds: 900,
    measurement: { ...measurement, status: "estimated" },
    target: null,
    series: [
      {
        stage: "processing",
        name: "Processamento",
        points: [{ timestamp: "2026-01-01T12:00:00.000Z", value: 800 }],
      },
    ],
    peak: {
      timestamp: "2026-01-01T12:00:00.000Z",
      stage: "processing",
      value: 800,
    },
  },
  sources: [
    {
      id: "argus",
      name: "argus",
      type: "batch",
      workers: ["argus"],
      lastRunAt: "2026-01-01T12:00:00.000Z",
      lastSuccessfulRunAt: "2026-01-01T12:00:00.000Z",
      observedThrough: "2026-01-01T12:00:00.000Z",
      lagSeconds: 0,
      state: "stable",
      records: {
        read: 100,
        written: 100,
        rejected: 0,
        measurement,
      },
      coverage: { value: 1, unit: "ratio", measurement },
    },
  ],
  geography: { granularity: "state", metrics: [], areas: [] },
  facets: { sources: ["argus"] },
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
    latestMonitoring: vi.fn(async () => ({
      data: monitoringData,
      observedThrough: "2026-01-01T12:00:00.000Z",
      coverageRatio: 1,
      source: "argus",
    })),
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

  it("returns the versioned monitoring projection with honest partial warnings", async () => {
    const storage = repository();
    const active = resolver();
    await expect(
      new DashboardQueries(storage, active, ["argus"], () => now).monitoring({
        window: "15m",
        flowMetric: "processing_latency",
      }),
    ).resolves.toMatchObject({
      data: monitoringData,
      quality: {
        partial: true,
        warnings: [
          expect.objectContaining({
            code: "ANALYSIS_QUEUE_METRICS_UNAVAILABLE",
          }),
        ],
      },
    });
    expect(active.resolve).toHaveBeenCalledTimes(1);
    expect(storage.latestMonitoring).toHaveBeenCalledWith(
      activeDataset,
      new Date("2026-01-01T11:45:00.000Z"),
      now,
      ["argus"],
    );
  });

  it("rejects a monitoring source outside the configured allowlist", async () => {
    const storage = repository();
    await expect(
      new DashboardQueries(
        storage,
        resolver(),
        ["argus"],
        () => now,
      ).monitoring({
        window: "15m",
        source: "unknown",
        flowMetric: "processing_latency",
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "UNSUPPORTED_FILTER_COMBINATION",
    });
    expect(storage.latestMonitoring).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mapIncidents } from "@/app/(painel)/incidentes/incidents-resource";
import { mapOverview, type OverviewResponse } from "@/app/(painel)/visao-geral/overview-resource";

afterEach(() => vi.restoreAllMocks());

describe("dashboard DTO adapters", () => {
  it("maps measured overview fields and preserves unknown as null", () => {
    const response: OverviewResponse = {
      kpis: [
        { key: "errors_per_minute", value: 12, unit: "errors_per_minute", status: "critical", comparison: null, measurement: { status: "measured" } },
        { key: "latency_p95", value: null, unit: "milliseconds", status: "unknown", comparison: null, measurement: { status: "unknown" } },
      ],
      experienceHealth: { baselineValue: null, points: [{ timestamp: "2026-01-01T00:00:00Z", value: 12 }], anomalyWindows: [] },
      recentIncidents: [],
    };
    const mapped = mapOverview(response);
    expect(mapped.stats.map((item) => item.value)).toEqual([12, null]);
    expect(mapped.baseline).toBeNull();
    expect(mapped.anomalyRange).toBeNull();
  });

  it("does not turn unknown incident impact into zero", () => {
    const mapped = mapIncidents({
      items: [
        { id: "inc_unknown", title: "Unknown impact", priority: "P2", startedAt: "2026-01-01T00:00:00Z", impact: { affectedDevices: { value: null, measurement: { status: "unknown" } } }, primaryComponent: null, scopeSummary: [] },
        { id: "inc_measured", title: "Measured impact", priority: "P1", startedAt: "2026-01-01T00:00:00Z", impact: { affectedDevices: { value: 0, measurement: { status: "measured" } } }, primaryComponent: null, scopeSummary: [] },
      ],
      impactSeries: { points: [] },
    });
    expect(mapped.map((item) => item.id)).toEqual(["inc_unknown", "inc_measured"]);
    expect(mapped[0]?.devices).toBeNull();
    expect(mapped[1]?.devices).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const meta = {
  requestId: "req_projection",
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  window: null,
  partial: false,
  refreshAfterSeconds: 60,
  freshness: [],
  warnings: [],
};
const measured = (value: number | null) => ({ value, measurement: { status: value === null ? "unknown" : "measured", source: "seed-carga" } });

describe("published dashboard projections", () => {
  it("uses explicitly enabled example monitoring data when no gateway is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    const { fetchMonitoringOverview } = await import("@/app/(painel)/monitoramento/telemetry-resource");
    const resource = await fetchMonitoringOverview("15");
    expect(resource.source).toBe("exemplo");
    expect(resource.data?.sources.length).toBeGreaterThan(0);
    expect(resource.data?.flow.series[0]?.points.length).toBeGreaterThan(0);
  });

  it("preserves sources with missing metrics and reads the flow from the published projection", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        data: {
          kpis: { ingestionRate: measured(9800), processingLatencyP95: measured(1200), queueDepth: measured(null), deadLetterQueue: { ...measured(null), newInWindow: null } },
          sources: [{ id: "argus", name: "Argus", workers: ["argus-worker-1"], observedThrough: new Date().toISOString(), lagSeconds: 0, state: "stable", records: { read: 15000, written: 14950, rejected: 50 }, coverage: measured(0.99), ingestionRate: measured(9800), processingLatencyP95: measured(null) }],
          flow: { metric: "processing_latency", unit: "ms", series: [{ stage: "processing", name: "Processamento", points: [{ timestamp: new Date().toISOString(), value: 1200 }] }], peak: null, target: null, measurement: { status: "measured", source: "seed-carga" } },
          geography: { areas: [{ code: "SP", name: "São Paulo", region: "Sudeste", observedSessions: measured(18000), values: { instabilityRatio: measured(0.02), latencyP95: measured(1200), eventLossRatio: measured(0.003) } }] },
          topology: { status: "available", services: [{ service: "Player", status: "healthy", calls: 100, errors: 0, errorRate: 0, latencyP95: 120 }], dependencies: [] },
        },
        meta,
      }), { status: 200 });
    }));
    const { fetchMonitoringOverview } = await import("@/app/(painel)/monitoramento/telemetry-resource");
    const monitoring = await fetchMonitoringOverview("360");
    expect(monitoring.data?.sources).toHaveLength(1);
    expect(monitoring.data?.sources[0]?.processingLatencyP95?.value).toBeNull();
    expect(monitoring.data?.flow.series[0]?.points[0]?.value).toBe(1200);
    expect(monitoring.data?.topology?.services).toHaveLength(1);
    expect(urls).toHaveLength(1);
    expect(urls.every((url) => url.includes("window=6h"))).toBe(true);
  });

  it("maps persisted diagnosis charts, concentration, evidence and timeline", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const now = new Date().toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: {
        incident: { id: "inc_1", title: "Player degradation", priority: "P1", status: "investigating", startedAt: now, impact: { affectedDevices: { value: 120, measurement: { status: "measured" } } }, primaryComponent: { id: "cmp_1", name: "Player" } },
        diagnosis: { status: "ready", summary: "Cause", primaryHypothesisId: "hyp_1", confidence: 0.8, hypotheses: [{ id: "hyp_1", statement: "Decoder", component: null, probability: 0.8, rationale: "Details", review: { status: "pending", version: 0 } }] },
        evidence: [{ id: "evi_1", type: "metric", title: "Deviation", statement: "Buffering increased", relation: "supports", strength: "strong", source: { type: "telemetry", name: "Argus" }, quality: { status: "verified", flags: [] } }],
        charts: { buffering: { points: [{ timestamp: now, value: 3.2 }], marker: { timestamp: now, label: "Detection" } }, concentrations: [{ label: "Smart TV", percentage: 68 }], concentrationNote: "Sample" },
        timeline: [{ timestamp: now, label: "Incident detected", source: "Argus", tone: "critical" }],
        changes: [{ label: "Likely", cause: "Player", percentage: 72, tone: "critical" }],
      },
      meta,
    }), { status: 200 })));
    const { fetchEvidence, fetchBuffering } = await import("@/app/(painel)/evidencias/evidence-resource");
    const evidence = await fetchEvidence("inc_1");
    const buffering = await fetchBuffering("inc_1", "120");
    expect(evidence.data).toMatchObject({ sources: [{ source: "Argus" }], concentration: [{ label: "Smart TV", percentage: 68 }], timeline: [{ label: "Incident detected" }], changes: [{ cause: "Player" }] });
    expect(buffering.data).toMatchObject({ points: [{ value: 3.2 }], marker: { index: 0 } });
  });

  it("keeps the last published monitoring series visible with its historical label", async () => {
    const { buildFlowChart } = await import("@/app/(painel)/monitoramento/telemetry-data");
    const oldPoint = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const series = buildFlowChart([{ flowSeries: [{ timestamp: oldPoint, processing: 1.2, ingestion: 0.4 }] } as Parameters<typeof buildFlowChart>[0][number]], "latencia", "30");
    expect(series).toMatchObject({ processing: [1.2], historical: true, observedAt: oldPoint });
  });
});

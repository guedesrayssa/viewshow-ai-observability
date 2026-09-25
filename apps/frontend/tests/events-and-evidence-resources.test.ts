import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const meta = {
  requestId: "req_argus",
  schemaVersion: "1.0",
  datasetVersion: `dsv_${"a".repeat(64)}`,
  generatedAt: "2026-01-01T12:00:00.000Z",
  window: {
    preset: null,
    from: "2026-01-01T11:00:00.000Z",
    to: "2026-01-01T12:00:00.000Z",
  },
  partial: false,
  refreshAfterSeconds: 900,
  freshness: [
    {
      source: "argus:events",
      observedThrough: "2026-01-01T11:59:00.000Z",
      lagSeconds: 60,
      state: "fresh",
    },
  ],
  warnings: [],
};

const event = {
  id: "evt_a56cfhze7zv2cj2fn5hwc35fm7",
  datasetVersion: meta.datasetVersion,
  category: "signal_observation",
  source: {
    system: "argus",
    dataset: "signal_bucket",
    recordId: '[["id","signal-1"]]',
    canonicalLocator: "canonical://dataset/signal_bucket/signal-1",
  },
  occurredAt: "2026-01-01T11:40:00.000Z",
  window: null,
  dimensions: { source: "video", region: "NE" },
  measures: { value: 8 },
  correlation: {
    status: "linked",
    incidentIds: ["inc_1"],
    links: [
      {
        correlationId: "cor_1",
        incidentId: "inc_1",
        ruleVersion: "argus-explicit-v1",
        timeDistanceSeconds: -120,
        matchedFields: [
          {
            eventField: "source",
            incidentField: "business_service",
            value: "video",
          },
        ],
      },
    ],
  },
  quality: {
    status: "measured",
    flags: [],
    observedThrough: "2026-01-01T11:59:00.000Z",
  },
  raw: { available: false, reason: "not_materialized_in_event_projection" },
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { data, meta } : data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ARGUS event and evidence resources", () => {
  it("appends a continuation page without losing or duplicating visible events", async () => {
    const { mergeEventPages } =
      await import("@/app/(painel)/eventos/events-resource");
    const first = { id: "evt_1" } as never;
    const repeated = { id: "evt_1" } as never;
    const second = { id: "evt_2" } as never;

    expect(
      mergeEventPages([first], [repeated, second]).map((item) => item.id),
    ).toEqual(["evt_1", "evt_2"]);
  });

  it("keeps a requested event visible ahead of a full first page", async () => {
    const { mergeRequestedEvent } =
      await import("@/app/(painel)/eventos/events-resource");
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `evt_${index}`,
    })) as never[];
    const requested = { id: event.id } as never;

    const merged = mergeRequestedEvent(firstPage, requested);

    expect(merged).toHaveLength(51);
    expect(merged[0]?.id).toBe(event.id);
  });

  it("reads an event directly from the incident-scoped detail route", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () => response(event));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEventDetail } =
      await import("@/app/(painel)/eventos/events-resource");

    const resource = await fetchEventDetail("inc_1", event.id);

    expect(resource.data).toMatchObject({
      id: event.id,
      source: "signal_bucket",
      detail: { canonicalLocator: event.source.canonicalLocator },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://gateway.test/api/v1/incidents/inc_1/events/${event.id}`,
    );
  });

  it("reads an event directly from the global detail route", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () => response(event));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEventDetail } =
      await import("@/app/(painel)/eventos/events-resource");

    await fetchEventDetail("", event.id);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://gateway.test/api/v1/events/${event.id}`,
    );
  });

  it("reads the global feed, maps traceability, and carries the next cursor", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        incident: null,
        capabilities: {
          filtering: {
            status: "available",
            supportedDimensions: ["category", "sourceDataset", "correlation"],
            supportedFilterSets: [["category", "sourceDataset", "correlation"]],
          },
        },
        categoryStats: [{ category: "signal_observation", count: 1 }],
        volumeSeries: null,
        items: [event],
        facets: {
          categories: ["signal_observation"],
          sourceDatasets: ["signal_bucket"],
          correlationStatuses: ["linked"],
        },
        page: { limit: 50, hasMore: true, nextCursor: "cursor-2" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEvents } =
      await import("@/app/(painel)/eventos/events-resource");

    const resource = await fetchEvents({
      incidentId: "",
      period: "all",
      search: "video",
      category: "signal_observation",
      source: "signal_bucket",
      correlation: "linked",
      cursor: "cursor-1",
    });

    expect(resource.data).toMatchObject({
      events: [
        {
          id: event.id,
          source: "signal_bucket",
          entity: "video",
          quality: { label: "Vinculado" },
          detail: {
            sourceRecordId: event.source.recordId,
            canonicalLocator: event.source.canonicalLocator,
            rawAvailable: false,
          },
        },
      ],
      nextCursor: "cursor-2",
      hasMore: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/events?");
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "sourceDataset=signal_bucket",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain("cursor=cursor-1");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("window=all");
  });

  it("requests the complete canonical interval for the all-period Incident feed", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        items: [],
        impactSeries: { points: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchIncidents } =
      await import("@/app/(painel)/incidentes/incidents-resource");

    await fetchIncidents({
      period: "all",
      deviceType: "all",
      region: "all",
      appVersion: "all",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("window=all");
  });

  it("uses the incident-scoped feed when an incident is selected", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () =>
      response({
        incident: { id: "inc_1", number: "INC-1", title: "Incident" },
        capabilities: {
          filtering: {
            status: "available",
            supportedDimensions: [],
            supportedFilterSets: [],
          },
        },
        categoryStats: [],
        volumeSeries: null,
        items: [],
        facets: {
          categories: [],
          sourceDatasets: [],
          correlationStatuses: [],
        },
        page: { limit: 50, hasMore: false, nextCursor: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEvents } =
      await import("@/app/(painel)/eventos/events-resource");

    await fetchEvents({
      incidentId: "inc_1",
      period: "30",
      search: "",
      category: "all",
      source: "all",
      correlation: "all",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/v1/incidents/inc_1/events?",
    );
  });

  it("shows correlated evidence even when impact and hypotheses are unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          incident: {
            id: "inc_1",
            title: "Incident",
            priority: "P2",
            status: "investigating",
            startedAt: "2026-01-01T11:30:00.000Z",
            impact: {
              affectedDevices: {
                value: null,
                measurement: { status: "unknown" },
              },
            },
            primaryComponent: null,
          },
          diagnosis: {
            status: "not_started",
            summary: null,
            primaryHypothesisId: null,
            confidence: null,
            hypotheses: [],
          },
          evidence: [
            {
              id: "evd_1",
              eventId: event.id,
              incidentId: "inc_1",
              type: "argus_event_correlation",
              relation: "context",
              hypothesisIds: [],
              strength: "moderate",
              observedAt: event.occurredAt,
              source: {
                type: "argus_event",
                name: "signal_bucket",
                dataset: "signal_bucket",
                recordId: event.source.recordId,
              },
              correlation: event.correlation.links[0],
              quality: { status: "verified", coverageRatio: 1, flags: [] },
            },
          ],
          charts: { buffering: null, concentrations: [] },
          timeline: [],
          dataQuality: {
            status: "sufficient",
            coverageRatio: 1,
            observedThrough: "2026-01-01T11:59:00.000Z",
            gaps: [],
          },
        }),
      ),
    );
    const { fetchEvidence } =
      await import("@/app/(painel)/evidencias/evidence-resource");

    const resource = await fetchEvidence("inc_1");

    expect(resource.data).toMatchObject({
      incident: { affectedDevices: null },
      hypothesis: null,
      sources: [
        {
          eventId: event.id,
          incidentId: "inc_1",
          observedAt: event.occurredAt,
          qualityStatus: "verified",
          source: "signal_bucket",
          summary: "Evento ARGUS correlacionado ao incidente",
        },
      ],
    });
    expect(resource.data?.sources[0]?.detail).toContain("argus-explicit-v1");
    expect(resource.data?.sources[0]?.detail).toContain(event.id);
  });

  it("never substitutes example events or evidence after a gateway failure", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            error: {
              code: "DATA_UNAVAILABLE",
              message: "projection missing",
              requestId: "req_error",
            },
          },
          503,
        ),
      ),
    );
    const { fetchEvents } =
      await import("@/app/(painel)/eventos/events-resource");
    const { fetchEvidence } =
      await import("@/app/(painel)/evidencias/evidence-resource");

    const events = await fetchEvents({
      incidentId: "",
      period: "30",
      search: "",
      category: "all",
      source: "all",
      correlation: "all",
    });
    const evidence = await fetchEvidence("inc_1");

    expect(events.data).toBeUndefined();
    expect(evidence.data).toBeUndefined();
    expect(events.source).toBe("indisponivel");
    expect(evidence.source).toBe("indisponivel");
  });
});

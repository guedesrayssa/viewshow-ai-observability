import { describe, expect, it, vi } from "vitest";
import {
  eventsQuerySchema,
  incidentsQuerySchema,
  type EventDto,
  type EvidenceDto,
} from "@view-show/contracts";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../src/modules/datasets/ports/active-dataset-resolver.js";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.js";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.js";
import type {
  EventReadPage,
  IncidentRepository,
  ReviewWrite,
} from "../src/modules/incidents/ports/incident-repository.js";

const now = new Date("2026-01-01T12:00:00Z");
const datasetVersion = `dsv_${"a".repeat(64)}` as const;
const activeDataset: ActiveDatasetSnapshot = {
  datasetVersion,
  formulaVersions: {
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
    events: "1.0",
    evidence: "1.0",
  },
  projectionVersions: {
    geography: "1.0",
    incidents: "1.0",
    monitoring: "1.0",
    overview: "1.0",
    events: "1.0",
    evidence: "1.0",
  },
  availableIntervals: {},
  hotFrom: {},
};

const event: EventDto = {
  id: "evt_a56cfhze7zv2cj2fn5hwc35fm7",
  datasetVersion,
  category: "signal_observation",
  source: {
    system: "argus",
    dataset: "signal_bucket",
    recordId: '[["id","signal-1"]]',
    canonicalLocator: "canonical://dsv/signal_bucket/record",
  },
  occurredAt: "2026-01-01T11:40:00.000Z",
  window: null,
  dimensions: { source: "video" },
  measures: { value: 8 },
  correlation: {
    status: "linked",
    incidentIds: ["inc_1"],
    links: [
      {
        correlationId: "cor_1",
        incidentId: "inc_1",
        ruleVersion: "argus-explicit-v1",
        timeDistanceSeconds: 0,
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
    observedThrough: "2026-01-01T11:45:00.000Z",
  },
  raw: { available: false, reason: "not_materialized_in_event_projection" },
};

const evidence: EvidenceDto = {
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
  correlation: event.correlation.links[0]!,
  quality: { status: "verified", coverageRatio: 1, flags: [] },
};

function activeResolver(
  value: ActiveDatasetSnapshot | null = activeDataset,
): ActiveDatasetResolver & { readonly resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(async () => value) };
}

function eventPage(next: EventReadPage["next"] = null): EventReadPage {
  return {
    items: [event],
    categoryStats: [{ category: event.category, count: 1 }],
    facets: {
      categories: ["signal_observation"],
      sourceDatasets: ["signal_bucket"],
      correlationStatuses: ["linked"],
    },
    next,
  };
}

function repository(): IncidentRepository & {
  readonly listEvents: ReturnType<typeof vi.fn>;
  readonly getEvent: ReturnType<typeof vi.fn>;
  readonly listEvidence: ReturnType<typeof vi.fn>;
} {
  return {
    activeProjection: vi.fn(async () => ({
      observedThrough: "2026-01-01T11:45:00.000Z",
      coverage: "complete" as const,
      incidents: [
        {
          incidentId: "inc_1",
          number: "INC-001",
          openedAt: "2026-01-01T11:40:00.000Z",
          state: "open",
          priority: "P2" as const,
        },
      ],
    })),
    eventProjection: vi.fn(async () => ({
      observedThrough: "2026-01-01T11:45:00.000Z",
      coverage: "complete" as const,
      qualityFlags: [],
    })),
    listEvents: vi.fn(async () => eventPage()),
    getEvent: vi.fn(async () => event),
    listEvidence: vi.fn(async () => [evidence]),
    listBetween: vi.fn(async () => {
      throw new Error("legacy incident list must stay disconnected");
    }),
    bundle: vi.fn(async () => {
      throw new Error("legacy incident detail must stay disconnected");
    }),
    writeReview: vi.fn(async (_write: ReviewWrite) => {
      throw new Error("legacy incident review must stay disconnected");
    }),
  };
}

function useCases(
  storage: IncidentRepository,
  active: ActiveDatasetSnapshot = activeDataset,
): IncidentUseCases {
  return new IncidentUseCases(
    storage,
    activeResolver(active),
    new CursorCodec("c".repeat(32)),
    new UnavailableReviewFeedbackPort(),
    () => now,
  );
}

describe("incident, Event, and Evidence use cases", () => {
  it("maps the active Incident projection without inventing impact counts", async () => {
    const storage = repository();
    const result = await useCases(storage).list(
      incidentsQuerySchema.parse({ window: "1h" }),
    );

    expect(result.data.items[0]).toMatchObject({
      id: "inc_1",
      number: "INC-001",
      priority: "P2",
      status: "investigating",
      impact: { affectedDevices: { value: null } },
    });
    expect(storage.listBetween).not.toHaveBeenCalled();
  });

  it("returns the global feed with real filters, facets, and a signed continuation", async () => {
    const storage = repository();
    storage.listEvents.mockResolvedValueOnce({
      ...eventPage({ day: "20260101", sortKey: "OCCURRED#1#EVENT#evt" }),
      categoryStats: [{ category: "signal_observation", count: 42 }],
    });

    const result = await useCases(storage).globalEvents(
      eventsQuerySchema.parse({
        window: "1h",
        sourceDataset: "signal_bucket",
        correlation: "linked",
        limit: 1,
      }),
    );

    expect(result.data.incident).toBeNull();
    expect(result.data.items).toEqual([event]);
    expect(result.data.page.nextCursor).toEqual(expect.any(String));
    expect(result.data.categoryStats).toEqual([
      { category: "signal_observation", count: 42 },
    ]);
    expect(result.quality.freshness[0]).toMatchObject({
      source: "argus:events",
      observedThrough: "2026-01-01T11:45:00.000Z",
    });
    expect(storage.listEvents).toHaveBeenCalledWith(
      activeDataset,
      expect.objectContaining({
        incidentId: null,
        sourceDataset: "signal_bucket",
        correlation: "linked",
        limit: 1,
      }),
    );
  });

  it("uses the canonical dataset interval for the all-period Event feed", async () => {
    const storage = repository();
    const active = {
      ...activeDataset,
      availableIntervals: {
        signal_bucket: [
          {
            start: "2025-12-01T00:00:00.000Z",
            end: "2025-12-02T00:00:00.000Z",
          },
        ],
        live_event: [
          {
            start: "2025-11-20T00:00:00.000Z",
            end: "2025-12-03T00:00:00.000Z",
          },
        ],
      },
    } satisfies ActiveDatasetSnapshot;

    const result = await useCases(storage, active).globalEvents(
      eventsQuerySchema.parse({ window: "all" }),
    );

    expect(storage.listEvents).toHaveBeenCalledWith(
      active,
      expect.objectContaining({
        from: "2025-11-20T00:00:00.000Z",
        to: "2025-12-03T00:00:00.000Z",
      }),
    );
    expect(result.quality.window).toEqual({
      preset: "all",
      from: "2025-11-20T00:00:00.000Z",
      to: "2025-12-03T00:00:00.000Z",
    });
  });

  it("binds the cursor to dataset, filters, and ordering", async () => {
    const storage = repository();
    storage.listEvents.mockResolvedValueOnce(
      eventPage({ day: "20260101", sortKey: "OCCURRED#1#EVENT#evt" }),
    );
    const subject = useCases(storage);
    const first = await subject.globalEvents(
      eventsQuerySchema.parse({ window: "1h", correlation: "linked" }),
    );

    await expect(
      subject.globalEvents(
        eventsQuerySchema.parse({
          window: "1h",
          correlation: "unlinked",
          cursor: first.data.page.nextCursor!,
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("returns only persisted links in Incident mode", async () => {
    const storage = repository();
    const result = await useCases(storage).events(
      "inc_1",
      eventsQuerySchema.parse({ window: "1h" }),
    );

    expect(result.data.incident).toEqual({
      id: "inc_1",
      number: "INC-001",
      title: "INC-001",
    });
    expect(storage.listEvents).toHaveBeenCalledWith(
      activeDataset,
      expect.objectContaining({ incidentId: "inc_1", correlation: "linked" }),
    );
  });

  it("accepts the signed continuation emitted in Incident mode", async () => {
    const storage = repository();
    storage.listEvents
      .mockResolvedValueOnce(
        eventPage({ day: "incident", sortKey: "EVENT#1#evt_1" }),
      )
      .mockResolvedValueOnce(eventPage(null));
    const subject = useCases(storage);

    const first = await subject.events(
      "inc_1",
      eventsQuerySchema.parse({ window: "1h", limit: 1 }),
    );
    await subject.events(
      "inc_1",
      eventsQuerySchema.parse({
        window: "1h",
        limit: 1,
        cursor: first.data.page.nextCursor!,
      }),
    );

    expect(storage.listEvents).toHaveBeenLastCalledWith(
      activeDataset,
      expect.objectContaining({
        incidentId: "inc_1",
        position: { day: "incident", sortKey: "EVENT#1#evt_1" },
      }),
    );
  });

  it("returns Evidence even when no hypothesis exists", async () => {
    const result = await useCases(repository()).diagnosis("inc_1");

    expect(result.data.diagnosis.status).toBe("not_started");
    expect(result.data.diagnosis.hypotheses).toEqual([]);
    expect(result.data.evidence).toEqual([evidence]);
    expect(result.data.charts).toEqual({
      buffering: null,
      concentrations: [],
      concentrationNote: "",
    });
    expect(result.data.changes).toEqual([]);
    expect(result.data.dataQuality.status).toBe("sufficient");
  });

  it("serves canonical and Incident-scoped Event detail", async () => {
    const storage = repository();
    const subject = useCases(storage);

    await expect(subject.globalEvent(event.id)).resolves.toMatchObject({
      data: event,
      datasetVersion,
    });
    await expect(subject.event("inc_1", event.id)).resolves.toMatchObject({
      data: event,
      datasetVersion,
    });
    expect(storage.getEvent).toHaveBeenNthCalledWith(
      1,
      activeDataset,
      event.id,
      null,
    );
    expect(storage.getEvent).toHaveBeenNthCalledWith(
      2,
      activeDataset,
      event.id,
      "inc_1",
    );
  });

  it("distinguishes an unavailable projection from a missing Event", async () => {
    const missingProjection = repository();
    vi.mocked(missingProjection.eventProjection).mockResolvedValueOnce(null);
    await expect(
      useCases(missingProjection).globalEvents(eventsQuerySchema.parse({})),
    ).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE" });

    const missingEvent = repository();
    missingEvent.getEvent.mockResolvedValueOnce(null);
    await expect(
      useCases(missingEvent).globalEvent(event.id),
    ).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
  });
});

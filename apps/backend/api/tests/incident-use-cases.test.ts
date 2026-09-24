import { describe, expect, it, vi } from "vitest";
import { incidentsQuerySchema, ServiceError } from "@view-show/contracts";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.js";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.js";
import type {
  IncidentRepository,
  ReviewWrite,
} from "../src/modules/incidents/ports/incident-repository.js";

const now = new Date("2026-01-01T12:00:00Z");
const items = Array.from({ length: 4 }, (_, index) => ({
  itemType: "incident",
  id: `inc_${index}`,
  title: `Incident ${index}`,
  priority: index === 0 ? "P1" : "P3",
  status: "investigating",
  startedAt: new Date(now.getTime() - index * 60_000).toISOString(),
  affectedDevices: index + 1,
  deviceType: "smart-tv",
}));

function repository(
  overrides: Partial<IncidentRepository> = {},
): IncidentRepository {
  return {
    listBetween: vi.fn(async () => items),
    bundle: vi.fn(async () => ({ incident: items[0] ?? null, children: [] })),
    writeReview: vi.fn(async (write: ReviewWrite) => ({
      ...write.key,
      reviewVersion: write.expectedVersion + 1,
    })),
    ...overrides,
  };
}

describe("incident use cases", () => {
  it("paginates with a cursor bound to the original filters", async () => {
    const useCases = new IncidentUseCases(
      repository(),
      new CursorCodec("c".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const firstQuery = incidentsQuerySchema.parse({
      window: "1h",
      deviceType: "smart-tv",
      limit: 2,
    });
    const first = await useCases.list(firstQuery);
    expect(first.data.items).toHaveLength(2);
    expect(first.data.page.hasMore).toBe(true);
    const cursor = first.data.page.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await useCases.list(
      incidentsQuerySchema.parse({
        window: "1h",
        deviceType: "smart-tv",
        limit: 2,
        cursor,
      }),
    );
    expect(second.data.items.map((item) => item.id)).not.toEqual(
      first.data.items.map((item) => item.id),
    );
    await expect(
      useCases.list(
        incidentsQuerySchema.parse({
          window: "1h",
          region: "south",
          limit: 2,
          cursor,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unsupported filter combinations", async () => {
    const useCases = new IncidentUseCases(
      repository(),
      new CursorCodec("d".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    await expect(
      useCases.list(
        incidentsQuerySchema.parse({
          window: "1h",
          region: "south",
          deviceType: "tv",
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "UNSUPPORTED_FILTER_COMBINATION",
    });
  });

  it("returns persisted diagnosis absence as explicit partiality", async () => {
    const useCases = new IncidentUseCases(
      repository(),
      new CursorCodec("e".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const result = await useCases.diagnosis("inc_0");
    expect(result.data.diagnosis.status).toBe("not_started");
    expect(result.quality.warnings[0]?.code).toBe("AGENTIC_RESULT_UNAVAILABLE");
  });

  it("reads incident-scoped events from the repository and excludes physical keys", async () => {
    const useCases = new IncidentUseCases(
      repository({
        bundle: vi.fn(async () => ({
          incident: items[0] ?? null,
          children: [{
            pk: "INC#physical",
            sk: "EVENT#inc_0#001",
            ttl: 123,
            publicData: {
              id: "evt_1",
              timestamp: now.toISOString(),
              category: "error",
              source: { name: "seed-carga" },
              entity: "Player",
              summary: "Falha de reprodução",
              quality: { status: "verified", label: "Verificado" },
              dimensions: { deviceType: "smart-tv" },
              normalized: { metric: "playback_error", value: "1", tags: ["player"] },
              raw: { available: false },
            },
          }],
        })),
      }),
      new CursorCodec("f".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const result = await useCases.events("inc_0", { limit: 50, window: "1h" });
    expect(result.data.items).toMatchObject([{ id: "evt_1", category: "error" }]);
    expect(result.data.volumeSeries).toMatchObject({ points: [{ value: 1 }] });
    expect(result.quality.partial).toBe(false);
    expect(JSON.stringify(result.data)).not.toMatch(/"(?:pk|sk|ttl)"/);
    const detail = await useCases.event("inc_0", "evt_1");
    expect(detail.data.normalized.metric).toBe("playback_error");
    expect(detail.quality.warnings[0]?.code).toBe("RAW_PAYLOAD_UNAVAILABLE");
  });

  it("pages persisted events without shrinking the aggregate or losing filter binding", async () => {
    const children = Array.from({ length: 5 }, (_, index) => ({
      itemType: "event",
      publicData: {
        id: `evt_${index}`,
        timestamp: new Date(now.getTime() - index * 60_000).toISOString(),
        category: index % 2 === 0 ? "error" : "request",
        source: { name: "argus" },
        entity: "Player",
        summary: `Evento ${index}`,
        quality: { status: "verified" },
        dimensions: { region: index % 2 === 0 ? "Sudeste" : "Sul" },
        normalized: { metric: "event_count", value: "1", tags: [] },
        raw: { available: false },
      },
    }));
    const useCases = new IncidentUseCases(
      repository({ bundle: vi.fn(async () => ({ incident: items[0] ?? null, children })) }),
      new CursorCodec("p".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const first = await useCases.events("inc_0", { limit: 2, window: "1h" });
    expect(first.data.items.map((event) => event.id)).toEqual(["evt_0", "evt_1"]);
    expect(first.data.page.hasMore).toBe(true);
    expect(first.data.categoryStats[0]?.total).toBe(5);
    expect(first.data.volumeSeries?.points.reduce((sum, point) => sum + point.value, 0)).toBe(5);
    const second = await useCases.events("inc_0", { limit: 2, window: "1h", cursor: first.data.page.nextCursor! });
    expect(second.data.items.map((event) => event.id)).toEqual(["evt_2", "evt_3"]);
    await expect(useCases.events("inc_0", { limit: 2, window: "1h", region: "Sul", cursor: first.data.page.nextCursor! }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("fails closed when reanalysis cannot find an incident or publish its request", async () => {
    const missing = new IncidentUseCases(
      repository({
        bundle: vi.fn(async () => ({ incident: null, children: [] })),
      }),
      new CursorCodec("g".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const unavailable = new IncidentUseCases(
      repository(),
      new CursorCodec("h".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );

    await expect(
      missing.reanalyze("inc_missing", "rea_key", "usr_1"),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      unavailable.reanalyze("inc_0", "rea_key", "usr_1"),
    ).rejects.toMatchObject({ status: 503, code: "FEATURE_UNAVAILABLE" });
  });

  it("uses optimistic review version and defers unavailable feedback", async () => {
    const writeReview = vi.fn(async (write: ReviewWrite) => ({
      ...write.key,
      reviewVersion: write.expectedVersion + 1,
    }));
    const repo = repository({
      bundle: vi.fn(async () => ({
        incident: items[0] ?? null,
        children: [
          {
            itemType: "hypothesis",
            id: "hyp_1",
            statement: "Cause",
            probability: 0.8,
            reviewVersion: 2,
            pk: "P",
            sk: "S",
          },
        ],
      })),
      writeReview,
    });
    const useCases = new IncidentUseCases(
      repo,
      new CursorCodec("f".repeat(32)),
      new UnavailableReviewFeedbackPort(),
      () => now,
    );
    const result = await useCases.review(
      "inc_0",
      "hyp_1",
      { status: "confirmed", expectedVersion: 2 },
      "usr_1",
    );
    expect(writeReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerId: "usr_1", expectedVersion: 2 }),
    );
    expect(result.data.review.version).toBe(3);
    expect(result.quality.warnings[0]?.code).toBe("REVIEW_FEEDBACK_DEFERRED");
    await expect(
      useCases.review(
        "inc_0",
        "hyp_1",
        { status: "confirmed", expectedVersion: 1 },
        "usr_1",
      ),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

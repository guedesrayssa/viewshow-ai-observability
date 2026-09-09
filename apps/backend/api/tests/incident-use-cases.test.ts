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

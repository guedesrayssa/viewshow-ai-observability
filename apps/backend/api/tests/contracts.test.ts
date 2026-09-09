import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ServiceError,
  assertNoPhysicalFields,
  errorEnvelope,
  incidentsQuerySchema,
  responseMetaSchema,
  reviewBodySchema,
  successEnvelope,
} from "@view-show/contracts";

describe("versioned contracts", () => {
  it("validates temporal queries and optimistic review input", () => {
    expect(
      incidentsQuerySchema.parse({ window: "30m", limit: "10" }).limit,
    ).toBe(10);
    expect(() =>
      incidentsQuerySchema.parse({
        window: "30m",
        from: "2026-01-01T00:00:00Z",
      }),
    ).toThrow();
    expect(
      reviewBodySchema.parse({ status: "confirmed", expectedVersion: 4 }),
    ).toEqual({ status: "confirmed", expectedVersion: 4 });
    expect(() => reviewBodySchema.parse({ status: "confirmed" })).toThrow();
  });

  it("builds valid success and error envelopes with request ids", () => {
    const success = successEnvelope(
      {
        data: { value: 1 },
        quality: {
          window: null,
          partial: true,
          refreshAfterSeconds: 30,
          freshness: [],
          warnings: [{ code: "PARTIAL", message: "partial" }],
        },
      },
      "req_test",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(responseMetaSchema.parse(success.meta).requestId).toBe("req_test");
    expect(
      errorEnvelope(
        new ServiceError(503, "DATA_UNAVAILABLE", "missing"),
        "req_error",
      ).error,
    ).toMatchObject({ code: "DATA_UNAVAILABLE", requestId: "req_error" });
  });

  it("rejects physical persistence fields recursively", () => {
    expect(() =>
      assertNoPhysicalFields({ items: [{ pk: "secret" }] }),
    ).toThrowError(ServiceError);
    expect(() =>
      assertNoPhysicalFields({ page: { LastEvaluatedKey: {} } }),
    ).toThrowError(ServiceError);
    expect(() =>
      assertNoPhysicalFields({ items: [{ id: "opaque" }] }),
    ).not.toThrow();
  });

  it("publishes OpenAPI 3.1 for every public gateway operation", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/openapi/public.openapi.json", import.meta.url),
        "utf8",
      ),
    ) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/dashboard/overview",
      "/api/v1/incidents",
      "/api/v1/incidents/{incidentId}/diagnosis",
      "/api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review",
      "/api/v1/incidents/{incidentId}/events",
      "/api/v1/incidents/{incidentId}/events/{eventId}",
      "/api/v1/monitoring/overview",
      "/health",
      "/metrics",
    ])
      expect(document.paths).toHaveProperty(path);
  });
});

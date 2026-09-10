import { describe, expect, it } from "vitest";
import { Metrics } from "../src/observability/metrics.ts";

describe("application metrics", () => {
  it("records low-cardinality hypothesis review verdicts", async () => {
    const metrics = new Metrics("view-show-api");

    metrics.observeHypothesisReview("confirmed");

    expect(await metrics.registry.metrics()).toContain(
      'hypothesis_review_submissions_total{service_name="view-show-api",verdict="confirmed"} 1',
    );
    metrics.registry.clear();
  });
});

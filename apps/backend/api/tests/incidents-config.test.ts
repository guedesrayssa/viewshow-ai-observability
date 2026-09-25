import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/modules/incidents/config.js";

const base = { CURSOR_SECRET: "c".repeat(32) };

describe("incidents config: ANALYSIS_QUEUE_URL", () => {
  it("leaves reanalysis unconfigured when the variable is absent", () => {
    expect(loadConfig(base).analysisQueueUrl).toBeUndefined();
  });

  it("treats an empty value as no worker instead of failing the startup", () => {
    expect(
      loadConfig({ ...base, ANALYSIS_QUEUE_URL: "" }).analysisQueueUrl,
    ).toBeUndefined();
  });

  it("accepts the analysis queue URL", () => {
    const url = "https://sqs.us-east-1.amazonaws.com/123456789012/analysis";
    expect(
      loadConfig({ ...base, ANALYSIS_QUEUE_URL: url }).analysisQueueUrl,
    ).toBe(url);
  });

  it("still rejects a value that is not a URL", () => {
    expect(() =>
      loadConfig({ ...base, ANALYSIS_QUEUE_URL: "not-a-url" }),
    ).toThrow();
  });
});

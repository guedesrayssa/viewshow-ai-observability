import { describe, expect, it, vi } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { SqsReanalysisPublisher } from "../src/modules/incidents/adapters/sqs-reanalysis-publisher.js";

describe("SqsReanalysisPublisher", () => {
  it("publishes the versioned worker contract", async () => {
    const send = vi.fn(async () => ({}));
    const publisher = new SqsReanalysisPublisher(
      "https://sqs.us-east-1.amazonaws.com/1/analysis",
      "us-east-1",
      { send } as unknown as SQSClient,
    );
    await expect(
      publisher.publish({
        incidentId: "inc_1",
        idempotencyKey: "rea_1",
        requestedBy: "usr_1",
        reason: "MANUAL_REQUEST",
      }),
    ).resolves.toBe("accepted");
    const command = send.mock.calls[0]?.[0] as {
      input: { QueueUrl: string; MessageBody: string };
    };
    const body = JSON.parse(command.input.MessageBody);
    expect(command.input.QueueUrl).toContain("analysis");
    expect(body).toMatchObject({
      eventType: "REANALYSIS_REQUESTED",
      schemaVersion: "1.0",
      source: "backend-api",
      idempotencyKey: "rea_1",
      payload: {
        incidentId: "inc_1",
        requestedBy: "usr_1",
        reason: "MANUAL_REQUEST",
      },
    });
    expect(body.eventId).toMatch(/^evt_/);
    expect(body.traceId).toMatch(/^trc_/);
  });
});

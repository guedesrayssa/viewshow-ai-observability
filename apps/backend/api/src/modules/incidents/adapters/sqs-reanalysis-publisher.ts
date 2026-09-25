import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { ReanalysisPublisherPort } from "../ports/incident-repository.js";

export class SqsReanalysisPublisher implements ReanalysisPublisherPort {
  private readonly client: SQSClient;
  constructor(
    private readonly queueUrl: string,
    region: string,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({ region, maxAttempts: 4 });
  }
  async publish(request: {
    incidentId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: "MANUAL_REQUEST";
  }): Promise<"accepted"> {
    const now = new Date().toISOString(),
      id = randomUUID();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({
          eventId: `evt_${id}`,
          eventType: "REANALYSIS_REQUESTED",
          schemaVersion: "1.0",
          idempotencyKey: request.idempotencyKey,
          traceId: `trc_${id}`,
          occurredAt: now,
          producedAt: now,
          source: "backend-api",
          payload: request,
        }),
      }),
    );
    return "accepted";
  }
}

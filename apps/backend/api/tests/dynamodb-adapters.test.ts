import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoIncidentRepository } from "../incidents-service/src/adapters/dynamodb-incident-repository.js";

describe("DynamoDB adapters", () => {
  it("consumes successive query pages without exposing LastEvaluatedKey", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Items: [] })
      .mockResolvedValueOnce({
        Items: [
          {
            itemType: "incident",
            id: "inc_1",
            updatedAt: "2026-01-01T01:00:00Z",
          },
        ],
        LastEvaluatedKey: { pk: "physical", sk: "physical" },
      })
      .mockResolvedValueOnce({ Items: [] });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoIncidentRepository(
      "us-east-1",
      "table",
      client,
    );
    const result = await repository.listBetween(
      new Date("2026-01-01T00:30:00Z"),
      new Date("2026-01-01T01:30:00Z"),
    );
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.map((item) => item.id)).toContain("inc_1");
    expect(JSON.stringify(result)).not.toContain("LastEvaluatedKey");
  });

  it("uses a conditional update that prohibits phantom upsert", async () => {
    const send = vi.fn(async () => ({
      Attributes: { pk: "P", sk: "S", reviewVersion: 3 },
    }));
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoIncidentRepository(
      "us-east-1",
      "table",
      client,
    );
    await repository.writeReview({
      key: { pk: "P", sk: "S" },
      expectedVersion: 2,
      status: "confirmed",
      note: null,
      reviewedAt: "2026-01-01T00:00:00Z",
      reviewerId: "usr_1",
    });
    const command = send.mock.calls[0]?.[0] as {
      input?: { ConditionExpression?: string };
    };
    expect(command.input?.ConditionExpression).toContain(
      "attribute_exists(pk)",
    );
    expect(command.input?.ConditionExpression).toContain(
      "reviewVersion = :expectedVersion",
    );
  });

  it("contains no Scan command in request-path TypeScript", async () => {
    const sources = await Promise.all(
      [
        "../incidents-service/src/adapters/dynamodb-incident-repository.ts",
        "../dashboard-query-service/src/adapters/dynamodb-dashboard-read-repository.ts",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(/ScanCommand|\.scan\s*\(/);
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDashboardReadRepository } from "../src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.js";
import { createDashboardModule } from "../src/modules/dashboard/index.js";
import { DynamoIncidentRepository } from "../src/modules/incidents/adapters/dynamodb-incident-repository.js";
import { createIncidentsModule } from "../src/modules/incidents/index.js";

const dynamoClientInputs = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  return {
    ...actual,
    DynamoDBClient: class extends actual.DynamoDBClient {
      constructor(
        input: ConstructorParameters<typeof actual.DynamoDBClient>[0],
      ) {
        dynamoClientInputs.push(input as Record<string, unknown>);
        super(input);
      }
    },
  };
});

describe("DynamoDB adapters", () => {
  it("passes an explicit local endpoint from each module factory to the SDK client", () => {
    dynamoClientInputs.length = 0;
    const endpoint = "http://127.0.0.1:18000";

    createDashboardModule({ DYNAMODB_ENDPOINT: endpoint });
    createIncidentsModule({
      DYNAMODB_ENDPOINT: endpoint,
      CURSOR_SECRET: "c".repeat(32),
    });

    expect(dynamoClientInputs).toEqual([
      { region: "us-east-1", endpoint },
      { region: "us-east-1", endpoint },
    ]);
  });

  it("does not add endpoint or local credentials when local DynamoDB is not configured", () => {
    dynamoClientInputs.length = 0;

    createDashboardModule({});
    createIncidentsModule({ CURSOR_SECRET: "c".repeat(32) });

    expect(dynamoClientInputs).toEqual([
      { region: "us-east-1" },
      { region: "us-east-1" },
    ]);
  });

  it("queries the current UTC day for a sub-day overview window", async () => {
    const send = vi.fn(async () => ({ Items: [{ sk: "T#1788955200000", publicData: { kpis: [] } }] }));
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoDashboardReadRepository(
      "us-east-1",
      "table",
      client,
    );

    await repository.latestOverview(
      new Date("2026-09-09T11:30:00Z"),
      new Date("2026-09-09T12:00:00Z"),
    );

    const partitionKeys = send.mock.calls.map(
      ([command]) =>
        (command as { input: { ExpressionAttributeValues: { ":pk": string } } })
          .input.ExpressionAttributeValues[":pk"],
    );
    expect(partitionKeys).toEqual(["VIEW#OVERVIEW#GLOBAL#20260909"]);
  });

  it("returns the last retained monitoring snapshot when the requested window has none", async () => {
    const send = vi.fn(async (command: { input: { ScanIndexForward?: boolean } }) =>
      command.input.ScanIndexForward === false
        ? { Items: [{ sk: "T#1788955200000", publicData: { sources: [{ id: "argus" }] }, observedThrough: "2026-09-09T12:00:00Z" }] }
        : { Items: [] },
    );
    const repository = new DynamoDashboardReadRepository(
      "us-east-1", "table", { send } as unknown as DynamoDBDocumentClient,
    );

    const read = await repository.latestMonitoring(
      new Date("2026-09-09T12:45:00Z"),
      new Date("2026-09-09T13:00:00Z"),
      ["argus"],
    );

    expect(read?.observedThrough).toBe("2026-09-09T12:00:00Z");
    expect(read?.data.sources).toEqual([{ id: "argus" }]);
    expect(send.mock.calls.some(([command]) => command.input.ScanIndexForward === false)).toBe(true);
  });

  it("queries both UTC hour buckets touched by an incident window", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoIncidentRepository(
      "us-east-1",
      "table",
      client,
    );

    await repository.listBetween(
      new Date("2026-09-09T11:15:00Z"),
      new Date("2026-09-09T12:15:00Z"),
    );

    const partitionKeys = send.mock.calls.map(
      ([command]) =>
        (command as { input: { ExpressionAttributeValues: { ":pk": string } } })
          .input.ExpressionAttributeValues[":pk"],
    );
    expect(partitionKeys.filter((key) => key.startsWith("INC#"))).toEqual([
      "INC#2026-09-09T12",
      "INC#2026-09-09T11",
    ]);
  });

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
        "../src/modules/incidents/adapters/dynamodb-incident-repository.ts",
        "../src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.ts",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(/ScanCommand|\.scan\s*\(/);
  });
});

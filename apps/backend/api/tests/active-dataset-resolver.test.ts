import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";

const datasetVersion = `dsv_${"a".repeat(64)}`;
const activeFixture = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/active-dataset-v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

function activeItem(overrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(activeFixture),
    ...overrides,
  };
}

async function moduleUnderTest() {
  return import("../src/modules/datasets/adapters/dynamodb-active-dataset-resolver.js");
}

describe("DynamoDB ACTIVE dataset resolver", () => {
  it("uses a strongly consistent exact-key read and returns only the consumed contract", async () => {
    const { DynamoActiveDatasetResolver } = await moduleUnderTest();
    const send = vi.fn(async () => ({ Item: activeItem() }));
    const client = { send } as unknown as DynamoDBDocumentClient;

    const result = await new DynamoActiveDatasetResolver(
      "us-east-1",
      "operational-table",
      client,
    ).resolve();

    const command = send.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toEqual({
      TableName: "operational-table",
      Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
      ConsistentRead: true,
    });
    expect(result).toEqual({
      datasetVersion,
      formulaVersions: { overview: "1.0" },
      projectionVersions: { "overview/day": "1.0" },
      availableIntervals: {
        signal_bucket: [
          {
            start: "2026-08-01T00:00:00Z",
            end: "2026-09-01T00:00:00Z",
          },
        ],
      },
      hotFrom: { signal_bucket: "2026-08-18T00:00:00Z" },
    });
    expect(JSON.stringify(result)).not.toContain("CONTROL#DATASET");
    expect(JSON.stringify(result)).not.toContain("s3://");
  });

  it("returns null only when ACTIVE is absent", async () => {
    const { DynamoActiveDatasetResolver } = await moduleUnderTest();
    const client = {
      send: vi.fn(async () => ({})),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      new DynamoActiveDatasetResolver(
        "us-east-1",
        "operational-table",
        client,
      ).resolve(),
    ).resolves.toBeNull();
  });

  it.each([
    ["wrong key", activeItem({ pk: "CONTROL#OTHER" })],
    ["wrong entity", activeItem({ entityType: "CANDIDATE_MANIFEST" })],
    [
      "pointer mismatch",
      activeItem({ activeDatasetVersion: `dsv_${"e".repeat(64)}` }),
    ],
    [
      "invalid dataset version",
      activeItem({ activeDatasetVersion: "dsv_bad" }),
    ],
    [
      "invalid projection versions",
      activeItem({
        manifest: {
          ...(activeItem().manifest as Record<string, unknown>),
          metadata: {
            ...((activeItem().manifest as Record<string, unknown>)
              .metadata as Record<string, unknown>),
            projectionVersions: { incidents: "" },
          },
        },
      }),
    ],
    ["unexpected outer field", activeItem({ ttl: 1_800_000_000 })],
    [
      "metadata changed without a matching fingerprint",
      activeItem({
        manifest: {
          ...(activeItem().manifest as Record<string, unknown>),
          metadata: {
            ...((activeItem().manifest as Record<string, unknown>)
              .metadata as Record<string, unknown>),
            formulaVersions: { overview: "2.0" },
          },
        },
      }),
    ],
  ])("fails closed for a malformed ACTIVE item: %s", async (_name, item) => {
    const { ActiveDatasetContractError, DynamoActiveDatasetResolver } =
      await moduleUnderTest();
    const client = {
      send: vi.fn(async () => ({ Item: item })),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      new DynamoActiveDatasetResolver(
        "us-east-1",
        "operational-table",
        client,
      ).resolve(),
    ).rejects.toBeInstanceOf(ActiveDatasetContractError);
  });
});

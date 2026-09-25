import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDashboardReadRepository } from "../src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.js";
import { createDashboardModule } from "../src/modules/dashboard/index.js";
import { createActiveDatasetModule } from "../src/modules/datasets/index.js";
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
    const environment = {
      DYNAMODB_ENDPOINT: endpoint,
      CURSOR_SECRET: "c".repeat(32),
    };
    const activeDataset = createActiveDatasetModule(environment);

    createDashboardModule(environment, activeDataset);
    createIncidentsModule(environment, activeDataset);

    expect(dynamoClientInputs).toEqual([
      { region: "us-east-1", endpoint },
      { region: "us-east-1", endpoint },
      { region: "us-east-1", endpoint },
    ]);
  });

  it("does not add endpoint or local credentials when local DynamoDB is not configured", () => {
    dynamoClientInputs.length = 0;
    const environment = { CURSOR_SECRET: "c".repeat(32) };
    const activeDataset = createActiveDatasetModule(environment);

    createDashboardModule(environment, activeDataset);
    createIncidentsModule(environment, activeDataset);

    expect(dynamoClientInputs).toEqual([
      { region: "us-east-1" },
      { region: "us-east-1" },
      { region: "us-east-1" },
    ]);
  });

  it("reads and maps the latest versioned overview selected by ACTIVE", async () => {
    const datasetVersion = `dsv_${"a".repeat(64)}`;
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: `DATASET#${datasetVersion}#VIEW#OVERVIEW#live_qoe_hourly#20260909`,
            sk: "T#1788948000000",
            entityType: "PROJECTION",
            datasetVersion,
            partition: "year=2026/month=09/day=09",
            projectionPartitionKey: "DAY#20260909",
            projectionKey: "OVERVIEW#live_qoe_hourly",
            projectionVersion: "1.0",
            materializationRevision: `pmr_${"b".repeat(64)}`,
            requiredArchives: [
              {
                dataset: "live_qoe_hourly",
                partition: "year=2026/month=09/day=09",
              },
            ],
            payload: {
              projectionVersion: "1.0",
              formulaVersion: "1.0",
              inputWatermarks: {
                live_qoe_hourly: "2026-09-09T12:00:00.000Z",
              },
              observedThrough: "2026-09-09T12:00:00.000Z",
              coverage: "complete",
              qualityFlags: [],
              metrics: {
                sessions: 60,
                errors: 3,
                startupErrors: 1,
                botErrors: null,
                humanErrors: null,
                errorRate: 0.05,
              },
            },
            payloadFingerprint: "c".repeat(64),
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          pk: `DATASET#${datasetVersion}#VIEW#INCIDENTS#ACTIVE`,
          sk: "CURRENT",
          entityType: "PROJECTION",
          datasetVersion,
          partition: "current",
          projectionPartitionKey: "CURRENT",
          projectionKey: "INCIDENTS#ACTIVE",
          projectionVersion: "1.0",
          materializationRevision: `pmr_${"d".repeat(64)}`,
          requiredArchives: [
            {
              dataset: "incidents",
              partition: "year=2026/month=09/day=09",
            },
          ],
          payload: {
            projectionVersion: "1.0",
            formulaVersion: "1.0",
            inputWatermarks: {
              incidents: "2026-09-09T12:05:00.000Z",
            },
            observedThrough: "2026-09-09T12:05:00.000Z",
            coverage: "complete",
            qualityFlags: [],
            incidents: [
              {
                incidentId: "inc_fixture",
                number: "INC-001",
                openedAt: "2026-09-09T12:05:00.000Z",
                state: "open",
                priority: "2",
              },
            ],
          },
          payloadFingerprint: "e".repeat(64),
        },
      });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoDashboardReadRepository(
      "us-east-1",
      "table",
      client,
    );

    const result = await repository.activeOverview({
      datasetVersion,
      formulaVersions: { overview: "1.0" },
      projectionVersions: { overview: "1.0" },
      availableIntervals: {
        live_qoe_hourly: [
          {
            start: "2026-09-09T11:00:00.000Z",
            end: "2026-09-09T12:15:00.000Z",
          },
        ],
      },
      hotFrom: { live_qoe_hourly: "2026-09-09T11:00:00.000Z" },
    });

    expect(result?.data.kpis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "observed_sessions", value: 60 }),
        expect.objectContaining({ key: "error_rate", value: 5 }),
      ]),
    );
    expect(result?.data.recentIncidents).toEqual([
      expect.objectContaining({
        id: "inc_fixture",
        priority: "P2",
        status: "investigating",
      }),
    ]);
    expect(
      (send.mock.calls[0]![0] as QueryCommand).input.ExpressionAttributeValues,
    ).toMatchObject({
      ":pk": `DATASET#${datasetVersion}#VIEW#OVERVIEW#live_qoe_hourly#20260909`,
      ":current": "T#",
    });
  });

  it("reads monitoring only from the versioned namespace selected by ACTIVE", async () => {
    const datasetVersion = `dsv_${"a".repeat(64)}`;
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          pk: `DATASET#${datasetVersion}#VIEW#MONITORING#argus#20260909`,
          sk: "T#1788948000000",
          entityType: "PROJECTION",
          datasetVersion,
          partition: "year=2026/month=09/day=09",
          projectionPartitionKey: "VIEW#MONITORING#argus#20260909",
          projectionKey: "MONITORING#argus",
          projectionVersion: "1.0",
          materializationRevision: `pmr_${"b".repeat(64)}`,
          requiredArchives: [],
          payload: { observedThrough: "2026-09-09T12:00:00.000Z", sources: [] },
          payloadFingerprint: "c".repeat(64),
        },
      ],
    });
    const repository = new DynamoDashboardReadRepository("us-east-1", "table", {
      send,
    } as unknown as DynamoDBDocumentClient);
    const from = new Date("2026-09-09T11:00:00.000Z");
    const to = new Date("2026-09-09T13:00:00.000Z");

    const result = await repository.latestMonitoring(
      {
        datasetVersion,
        formulaVersions: {},
        projectionVersions: {},
        availableIntervals: {},
        hotFrom: {},
      },
      from,
      to,
      ["argus"],
    );

    expect(result).toEqual({
      data: { observedThrough: "2026-09-09T12:00:00.000Z", sources: [] },
      observedThrough: "2026-09-09T12:00:00.000Z",
      coverageRatio: null,
      source: "argus",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (send.mock.calls[0]![0] as QueryCommand).input.ExpressionAttributeValues,
    ).toEqual({
      ":pk": `DATASET#${datasetVersion}#VIEW#MONITORING#argus#20260909`,
      ":from": `T#${from.getTime()}`,
      ":to": `T#${to.getTime()}`,
    });
  });

  it("reads the active incident projection and normalizes numeric priorities", async () => {
    const datasetVersion = `dsv_${"f".repeat(64)}`;
    const send = vi.fn(async () => ({
      Item: {
        pk: `DATASET#${datasetVersion}#VIEW#INCIDENTS#ACTIVE`,
        sk: "CURRENT",
        entityType: "PROJECTION",
        datasetVersion,
        partition: "current",
        projectionPartitionKey: "CURRENT",
        projectionKey: "INCIDENTS#ACTIVE",
        projectionVersion: "1.0",
        materializationRevision: `pmr_${"b".repeat(64)}`,
        requiredArchives: [
          { dataset: "incidents", partition: "year=2026/month=09/day=09" },
        ],
        payload: {
          projectionVersion: "1.0",
          formulaVersion: "1.0",
          inputWatermarks: { incidents: "2026-09-09T12:05:00.000Z" },
          observedThrough: "2026-09-09T12:05:00.000Z",
          coverage: "complete",
          qualityFlags: [],
          incidents: [
            {
              incidentId: "inc_fixture",
              number: "INC-001",
              openedAt: "2026-09-09T12:00:00.000Z",
              state: "open",
              priority: "2",
            },
          ],
        },
        payloadFingerprint: "c".repeat(64),
      },
    }));
    const repository = new DynamoIncidentRepository("us-east-1", "table", {
      send,
    } as unknown as DynamoDBDocumentClient);

    const result = await repository.activeProjection({
      datasetVersion,
      formulaVersions: { incidents: "1.0" },
      projectionVersions: { incidents: "1.0" },
      availableIntervals: {},
      hotFrom: {},
    });

    expect(result?.incidents).toEqual([
      expect.objectContaining({ incidentId: "inc_fixture", priority: "P2" }),
    ]);
    expect((send.mock.calls[0]![0] as GetCommand).input.Key).toEqual({
      pk: `DATASET#${datasetVersion}#VIEW#INCIDENTS#ACTIVE`,
      sk: "CURRENT",
    });
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

    const partitionKeys = send.mock.calls
      .filter(([command]) => command instanceof QueryCommand)
      .map(
        ([command]) =>
          (
            command as {
              input: { ExpressionAttributeValues: { ":pk": string } };
            }
          ).input.ExpressionAttributeValues[":pk"],
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
      .mockResolvedValueOnce({ Item: undefined })
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

  it("reads global Events, detail, and incident Evidence from the active dataset namespace", async () => {
    const datasetVersion = `dsv_${"a".repeat(64)}`;
    const eventId = "evt_a56cfhze7zv2cj2fn5hwc35fm7";
    const link = {
      correlationId: "cor_1",
      eventId,
      incidentId: "inc_1",
      ruleVersion: "argus-explicit-v1",
      timeDistanceSeconds: 0,
      matchedFields: [["source", "business_service", "video"]],
    };
    const payload = {
      eventId,
      datasetVersion,
      category: "signal_observation",
      sourceSystem: "argus",
      sourceDataset: "signal_bucket",
      sourceRecordId: '[["id","signal-1"]]',
      canonicalLocator: "canonical://dsv/signal_bucket/record",
      occurredAt: "2026-01-01T11:40:00.000Z",
      sortAt: "2026-01-01T11:40:00.000Z",
      window: null,
      dimensions: { source: "video" },
      measures: { value: 8 },
      quality: {
        status: "measured",
        flags: [],
        observedThrough: "2026-01-01T11:45:00.000Z",
      },
      raw: { available: false, reason: "not_materialized_in_event_projection" },
      correlationStatus: "linked",
      incidentIds: ["inc_1"],
      correlations: [link],
      projectionVersion: "1.0",
      formulaVersion: "1.0",
      requiredArchives: [
        { dataset: "signal_bucket", partition: "snapshot_date=2026-01-01" },
      ],
      inputWatermarks: { signal_bucket: "2026-01-01T11:45:00.000Z" },
      observedThrough: "2026-01-01T11:45:00.000Z",
      coverage: "COMPLETE",
      qualityFlags: [],
    };
    const storedEvent = {
      pk: `DATASET#${datasetVersion}#VIEW#EVENTS#DAY#20260101`,
      sk: `OCCURRED#1767267600000#EVENT#${eventId}`,
      entityType: "EVENT",
      datasetVersion,
      materializationRevision: `pmr_${"b".repeat(64)}`,
      payload,
      payloadFingerprint: "c".repeat(64),
    };
    const storedLookup = {
      ...storedEvent,
      pk: `DATASET#${datasetVersion}#EVENT#${eventId}`,
      sk: "CURRENT",
      entityType: "EVENT_LOOKUP",
    };
    const storedLiveEvent = {
      ...storedEvent,
      sk: "OCCURRED#1767267600001#EVENT#evt_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      payload: {
        ...payload,
        eventId: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        category: "live_event",
        sourceDataset: "live_event",
        sourceRecordId: '[["id","live-1"]]',
        correlationStatus: "unlinked",
        incidentIds: [],
        correlations: [],
      },
    };
    const storedLiveContext = {
      ...storedEvent,
      sk: "OCCURRED#1767267600002#EVENT#evt_cccccccccccccccccccccccccc",
      payload: {
        ...payload,
        eventId: "evt_cccccccccccccccccccccccccc",
        category: "live_event_context",
        sourceDataset: "live_event_sde",
        sourceRecordId: '[["id","context-1"]]',
        correlationStatus: "unlinked",
        incidentIds: [],
        correlations: [],
      },
    };
    const storedEvidence = {
      ...storedEvent,
      pk: `DATASET#${datasetVersion}#INCIDENT#inc_1`,
      sk: "EVIDENCE#1767267600000#evd_1",
      entityType: "EVIDENCE",
      payload: {
        evidenceId: "evd_1",
        eventId,
        incidentId: "inc_1",
        correlationId: "cor_1",
        ruleVersion: "argus-explicit-v1",
        type: "argus_event_correlation",
        relation: "context",
        strength: "moderate",
        timeDistanceSeconds: 0,
        matchedFields: [["source", "business_service", "video"]],
        hypothesisIds: [],
        eventOccurredAt: "2026-01-01T11:40:00.000Z",
        sourceDataset: "signal_bucket",
        sourceRecordId: '[["id","signal-1"]]',
        requiredArchives: [],
        projectionVersion: "1.0",
        formulaVersion: "1.0",
        observedThrough: "2026-01-01T11:45:00.000Z",
        coverage: "COMPLETE",
        qualityFlags: [],
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [storedEvent, storedLiveEvent, storedLiveContext],
      })
      .mockResolvedValueOnce({ Item: storedLookup })
      .mockResolvedValueOnce({ Items: [storedEvidence] });
    const repository = new DynamoIncidentRepository("us-east-1", "table", {
      send,
    } as unknown as DynamoDBDocumentClient);
    const active = {
      datasetVersion,
      formulaVersions: { incidents: "1.0", events: "1.0", evidence: "1.0" },
      projectionVersions: {
        incidents: "1.0",
        events: "1.0",
        evidence: "1.0",
      },
      availableIntervals: {},
      hotFrom: {},
    };

    const page = await repository.listEvents(active, {
      incidentId: null,
      from: "2026-01-01T08:40:00.000-03:00",
      to: "2026-01-01T08:40:00.000-03:00",
      correlation: "all",
      sort: "recent",
      limit: 1,
      position: null,
    });
    const detail = await repository.getEvent(active, eventId, null);
    const evidence = await repository.listEvidence(active, "inc_1");
    send.mockResolvedValueOnce({
      Items: Array.from({ length: 10_001 }, () => storedEvent),
    });
    const overBudget = repository.listEvents(active, {
      incidentId: null,
      from: "2026-01-01T11:00:00.000Z",
      to: "2026-01-01T12:00:00.000Z",
      correlation: "all",
      sort: "recent",
      limit: 1,
      position: null,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: eventId,
        source: expect.objectContaining({ dataset: "signal_bucket" }),
        correlation: expect.objectContaining({ status: "linked" }),
      }),
    ]);
    expect(page.next).toEqual({
      day: "20260101",
      sortKey: storedEvent.sk,
    });
    expect(page.categoryStats).toEqual([
      { category: "live_event", count: 1 },
      { category: "live_event_context", count: 1 },
      { category: "signal_observation", count: 1 },
    ]);
    expect(page.facets).toEqual({
      categories: ["live_event", "live_event_context", "signal_observation"],
      sourceDatasets: ["live_event", "live_event_sde", "signal_bucket"],
      correlationStatuses: ["linked", "unlinked"],
    });
    expect(detail?.id).toBe(eventId);
    expect(evidence).toEqual([
      expect.objectContaining({
        id: "evd_1",
        eventId,
        correlation: expect.objectContaining({
          ruleVersion: "argus-explicit-v1",
        }),
      }),
    ]);
    await expect(overBudget).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect((send.mock.calls[0]![0] as QueryCommand).input).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": `DATASET#${datasetVersion}#VIEW#EVENTS#DAY#20260101`,
      },
      ScanIndexForward: false,
    });
    expect(JSON.stringify({ page, detail, evidence })).not.toMatch(
      /\b(pk|sk|payloadFingerprint|materializationRevision)\b/,
    );
  });

  it("contains no Scan command in request-path TypeScript", async () => {
    const sources = await Promise.all(
      [
        "../src/modules/incidents/adapters/dynamodb-incident-repository.ts",
        "../src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.ts",
        "../src/modules/imports/adapters/dynamodb-import-repository.ts",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(/ScanCommand|\.scan\s*\(/);
  });
});

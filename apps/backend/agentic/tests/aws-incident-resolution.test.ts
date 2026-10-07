import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import { DynamoAnalysisStore } from "../src/worker/aws.js";
import type { AnalysisScope } from "../src/worker/types.js";

const scope: AnalysisScope = {
  id: "fixture-edge-b",
  source: "prometheus",
  entity: "edge-b",
  priority: "P2",
  detectorMetrics: ["latency_ms_p95"],
  series: [
    {
      metric: "latency",
      seriesId: "ts_fixture_signal_latency",
      unit: "milliseconds",
      grainSeconds: 900,
    },
    {
      metric: "latency_ms_p95",
      seriesId: "ts_fixture_latency_p95",
      unit: "milliseconds",
      grainSeconds: 900,
    },
  ],
};

test("resolve a primeira reanálise pelo incidente público da ingestão", async () => {
  const calls: unknown[] = [];
  const client = {
    async send(command: GetCommand | QueryCommand) {
      calls.push(command);
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        if (key.pk === "ANALYSIS#INCIDENT#inc_public") return {};
        if (key.pk === "CONTROL#DATASET")
          return { Item: { activeDatasetVersion: "dsv_active" } };
      }
      if (command instanceof QueryCommand) {
        return {
          Items: [
            {
              pk: "DATASET#dsv_active#INCIDENT#inc_public",
              sk: "EVENT#1#evt_1",
              entityType: "INCIDENT_EVENT",
              payload: {
                category: "signal_observation",
                dimensions: {
                  metric: "latency",
                  source: "prometheus",
                  entity: "edge-b",
                },
                window: {
                  start: "2026-09-28T17:45:00.000Z",
                  end: "2026-09-28T18:00:00.000Z",
                  grainSeconds: 900,
                },
                quality: { observedThrough: "2026-09-28T18:05:00.000Z" },
              },
            },
          ],
        };
      }
      throw new Error("unexpected command");
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoAnalysisStore(client, "table", 0.1, [scope]);

  const resolved = await store.resolveIncident("inc_public");

  assert.equal(resolved.incidentId, "inc_public");
  assert.equal(resolved.scope.id, "fixture-edge-b");
  assert.deepEqual(resolved.event.payload, {
    window: {
      start: "2026-09-28T17:45:00.000Z",
      end: "2026-09-28T18:00:00.000Z",
      grainSeconds: 900,
    },
    inputWatermark: "2026-09-28T18:05:00.000Z",
    datasetVersion: "dsv_active",
    scope: { kind: "incident", dimensions: { scopeId: "fixture-edge-b" } },
  });
  assert.equal(calls.length, 3);
});

test("reanálise usa a versão atual do catálogo para incidente já conhecido", async () => {
  const oldScope = { ...scope, presentation: undefined };
  const configuredScope: AnalysisScope = {
    ...scope,
    presentation: { affectedDevicesMetric: "affected_devices" },
    series: [
      ...scope.series,
      {
        metric: "affected_devices",
        seriesId: "ts_fixture_affected_devices",
        unit: "devices",
        grainSeconds: 900,
      },
    ],
  };
  const event = {
    eventId: "evt_old",
    eventType: "ANOMALY_DETECTION",
    schemaVersion: "1.0",
    idempotencyKey: "old",
    traceId: "inc_known",
    occurredAt: "2026-09-28T18:00:00.000Z",
    producedAt: "2026-09-28T18:00:00.000Z",
    source: "incident-projection",
    payload: {
      window: {
        start: "2026-09-28T17:45:00.000Z",
        end: "2026-09-28T18:00:00.000Z",
        grainSeconds: 900,
      },
      inputWatermark: "2026-09-28T18:00:00.000Z",
      datasetVersion: "dsv_active",
    },
  };
  const client = {
    async send(command: GetCommand) {
      assert.ok(command instanceof GetCommand);
      return { Item: { event, scope: oldScope } };
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoAnalysisStore(client, "table", 0.1, [configuredScope]);

  const resolved = await store.resolveIncident("inc_known");

  assert.equal(resolved.scope, configuredScope);
  assert.equal(resolved.scope.presentation?.affectedDevicesMetric, "affected_devices");
});

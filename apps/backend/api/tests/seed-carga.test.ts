import { createRequire } from "node:module";
import {
  BatchWriteCommand,
  GetCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { decodeActiveDatasetItem } from "../src/modules/datasets/domain/active-dataset.js";
import { DynamoIncidentRepository } from "../src/modules/incidents/adapters/dynamodb-incident-repository.js";

const require = createRequire(import.meta.url);
const {
  buildVersionedItems,
  limparTabela,
}: {
  buildVersionedItems: (
    now: Date,
    incidents: Array<{
      id: string;
      startedAt: string;
      status: string;
      urgency: string;
      affectedSessions: number;
    }>,
  ) => Array<Record<string, any>>;
  limparTabela: (
    table: string,
    options: { documentClient: { send: ReturnType<typeof vi.fn> } },
  ) => Promise<number>;
} = require("../scripts/seed-carga.cjs");

describe("seed-carga versionado", () => {
  it("publica o manifesto por último e declara a indisponibilidade parcial de eventos", () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const incidents = [
      {
        id: "inc-000001",
        startedAt: "2026-09-25T11:50:00.000Z",
        status: "critical",
        urgency: "P1",
        affectedSessions: 100,
      },
    ];
    const items = buildVersionedItems(now, incidents);
    const manifest = items.at(-1)!;
    const summary = items.find(
      (item) => item.entityType === "EVENT_PROJECTION_SUMMARY",
    );

    expect(manifest.pk).toBe("CONTROL#DATASET");
    expect(decodeActiveDatasetItem(manifest).datasetVersion).toBe(
      manifest.activeDatasetVersion,
    );
    expect(manifest.manifest.metadata.projectionVersions).toMatchObject({
      incidents: "1.0",
      overview: "1.0",
      events: "1.0",
      evidence: "1.0",
    });
    expect(manifest.manifest.metadata.availableIntervals).toHaveProperty(
      "signal_bucket",
    );
    expect(summary?.payload).toMatchObject({
      coverage: "PARTIAL",
      qualityFlags: ["SEED_EVENTS_NOT_MATERIALIZED"],
    });
    expect(summary?.ttl).toBeGreaterThan(now.getTime() / 1000);
    expect(items.filter((item) => item.pk !== "CONTROL#DATASET")).toHaveLength(
      3,
    );
    expect(
      buildVersionedItems(new Date(now.getTime() + 1), incidents).at(-1)
        ?.activeDatasetVersion,
    ).not.toBe(manifest.activeDatasetVersion);
  });

  it("é consumido pelo adaptador de incidentes e pelo resumo de Eventos", async () => {
    const items = buildVersionedItems(new Date("2026-09-25T12:00:00.000Z"), [
      {
        id: "inc-000001",
        startedAt: "2026-09-25T11:50:00.000Z",
        status: "critical",
        urgency: "P1",
        affectedSessions: 100,
      },
    ]);
    const active = decodeActiveDatasetItem(items.at(-1));
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof GetCommand))
        throw new Error("Comando inesperado");
      return {
        Item: items.find(
          (item) =>
            item.pk === command.input.Key?.pk &&
            item.sk === command.input.Key?.sk,
        ),
      };
    });
    const repository = new DynamoIncidentRepository("us-east-1", "test", {
      send,
    } as unknown as DynamoDBDocumentClient);

    expect(await repository.activeProjection(active)).toMatchObject({
      incidents: [{ incidentId: "inc-000001" }],
    });
    expect(await repository.eventProjection(active)).toMatchObject({
      coverage: "partial",
      qualityFlags: ["SEED_EVENTS_NOT_MATERIALIZED"],
    });
  });

  it("limpa todas as páginas do seed sem apagar datasets de outros fluxos", async () => {
    const pages = [
      {
        Items: [
          { pk: "INC#2026-09-25T11", sk: "INCIDENT#inc-000001" },
          {
            pk: "DATASET#dsv_seed#VIEW#INCIDENTS#ACTIVE",
            sk: "CURRENT",
            datasetVersion: "dsv_seed",
            payload: { formulaVersion: "seed-carga-1.0" },
          },
          { pk: "IMPORTS", sk: "IMPORT#other" },
        ],
        LastEvaluatedKey: { pk: "IMPORTS", sk: "IMPORT#other" },
      },
      {
        Items: [
          {
            pk: "DATASET#dsv_seed#VIEW#EVENTS",
            sk: "SUMMARY",
            datasetVersion: "dsv_seed",
            payload: { formulaVersion: "seed-carga-1.0" },
          },
          {
            pk: "CONTROL#DATASET",
            sk: "ACTIVE",
            activeDatasetVersion: "dsv_seed",
            manifest: {
              datasetVersion: "dsv_seed",
              metadata: { formulaVersions: { incidents: "seed-carga-1.0" } },
            },
          },
          {
            pk: "DATASET#dsv_other#VIEW#INCIDENTS#ACTIVE",
            sk: "CURRENT",
            datasetVersion: "dsv_other",
            payload: { formulaVersion: "ingestion-1.0" },
          },
        ],
      },
    ];
    const writes: Array<{ pk: string; sk: string }> = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ScanCommand) return pages.shift();
      if (command instanceof BatchWriteCommand) {
        for (const request of command.input.RequestItems?.test ?? []) {
          const key = request.DeleteRequest?.Key;
          if (key) writes.push(key as { pk: string; sk: string });
        }
        return { UnprocessedItems: {} };
      }
      throw new Error("Comando inesperado");
    });

    const removed = await limparTabela("test", { documentClient: { send } });

    expect(removed).toBe(4);
    expect(writes.map(({ pk }) => pk)).toEqual(
      expect.arrayContaining([
        "INC#2026-09-25T11",
        "DATASET#dsv_seed#VIEW#INCIDENTS#ACTIVE",
        "DATASET#dsv_seed#VIEW#EVENTS",
        "CONTROL#DATASET",
      ]),
    );
    expect(writes.some(({ pk }) => pk.includes("dsv_other"))).toBe(false);
    expect(writes.some(({ pk }) => pk === "IMPORTS")).toBe(false);
  });
});

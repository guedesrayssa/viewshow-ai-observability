import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupLiveApiResources,
  liveApiChildEnvironment,
  requireDynamoDbEndpoint,
  terminateChild,
} from "../scripts/live-e2e-runtime.mjs";
import { SessionCodec } from "../src/modules/auth/domain/session.js";

const tableName = "monitoracao-operacional-e2e";
const authSecret = "a".repeat(32);
const cursorSecret = "c".repeat(32);

let client: DynamoDBClient | undefined;
let documentClient: DynamoDBDocumentClient | undefined;

let api: ChildProcessWithoutNullStreams | undefined;
let apiUrl = "";
let tableCreated = false;
let childOutput = "";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForDynamoDb(): Promise<void> {
  if (!client) throw new Error("DynamoDB client was not initialized");
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }), {
        abortSignal: AbortSignal.timeout(Math.min(1_000, remaining)),
      });
      return;
    } catch (error) {
      lastError = error;
      const retryDelay = deadline - Date.now();
      if (retryDelay > 0) await delay(Math.min(250, retryDelay));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("failed to allocate a local API port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForApi(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if (api?.exitCode !== null)
      throw new Error(`compiled API exited before readiness:\n${childOutput}`);
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(Math.min(1_000, remaining)),
      });
      if (response.status === 200) return;
    } catch {
      // The compiled process has not bound the free port yet.
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`compiled API did not become ready:\n${childOutput}`);
}

async function stopApi(): Promise<void> {
  if (!api) return;
  const child = api;
  api = undefined;
  await terminateChild(child);
}

describe.skipIf(process.env.RUN_LIVE_E2E !== "true")(
  "compiled API against DynamoDB Local",
  () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const incidentPk = `INC#${now.toISOString().slice(0, 13)}`;
    const hypothesisKey = {
      pk: incidentPk,
      sk: "INCIDENT#inc_e2e#HYPOTHESIS#hyp_e2e",
    };

    beforeAll(async () => {
      const endpoint = requireDynamoDbEndpoint(process.env);
      client = new DynamoDBClient({
        region: "us-east-1",
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      });
      documentClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
      await waitForDynamoDb();
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "trace_id", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "trace-index",
              KeySchema: [{ AttributeName: "trace_id", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      );
      tableCreated = true;

      const measurement = {
        status: "measured",
        source: "e2e",
        coverageRatio: 1,
        observedThrough: now.toISOString(),
      };
      const capabilities = {
        filtering: {
          status: "partial",
          supportedDimensions: [],
          supportedFilterSets: [[]],
        },
      };
      const kpis: unknown[] = [];
      const experienceHealth = {
        metric: "errors_per_minute",
        unit: "errors_per_minute",
        bucketSeconds: 60,
        baselineValue: null,
        measurement,
        points: [],
        anomalyWindows: [],
      };
      const recentIncidents: unknown[] = [];
      const facets = {};

      await Promise.all([
        documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: `VIEW#OVERVIEW#GLOBAL#${day}`,
              sk: `T#${now.getTime()}`,
              publicData: {
                capabilities,
                kpis,
                experienceHealth,
                recentIncidents,
                facets,
              },
              observedThrough: now.toISOString(),
              coverageRatio: 1,
              source: "e2e",
            },
          }),
        ),
        documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: `VIEW#MONITORING#argus#${day}`,
              sk: `T#${now.getTime()}`,
              publicData: {
                capabilities: {
                  sourceQuality: { status: "available" },
                  pipelineRuntime: {
                    status: "partial",
                    metrics: {
                      ingestionRate: "available",
                      processingLatencyP95: "available",
                      queueDepth: "unavailable",
                      deadLetterQueue: "unavailable",
                    },
                    reason: "BATCH_PIPELINE",
                  },
                  geographicMetrics: {
                    status: "available",
                    granularity: "state",
                  },
                  filtering: capabilities.filtering,
                },
                kpis: {},
                flow: {
                  metric: "processing_latency",
                  unit: "milliseconds",
                  bucketSeconds: 60,
                  measurement,
                  target: null,
                  series: [],
                  peak: null,
                },
                sources: [],
                geography: {
                  granularity: "state",
                  metrics: [],
                  areas: [],
                },
                facets,
              },
              observedThrough: now.toISOString(),
              coverageRatio: 1,
              source: "e2e",
            },
          }),
        ),
        documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: incidentPk,
              sk: "INCIDENT#inc_e2e",
              trace_id: "inc_e2e",
              itemType: "incident",
              id: "inc_e2e",
              number: "INC-E2E",
              title: "Live API incident",
              priority: "P1",
              status: "investigating",
              startedAt: now.toISOString(),
              updatedAt: now.toISOString(),
              affectedDevices: 2,
              affectedSessions: 3,
              shareOfObservedSessions: 0.5,
              componentId: "cmp_e2e",
              componentName: "video-player",
              coverageRatio: 1,
              observedThrough: now.toISOString(),
              source: "e2e",
            },
          }),
        ),
        documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              ...hypothesisKey,
              trace_id: "inc_e2e",
              itemType: "hypothesis",
              id: "hyp_e2e",
              statement: "A live dependency is degraded.",
              probability: 0.8,
              rationale: "Seeded by the live API test.",
              version: 1,
              reviewVersion: 0,
              reviewStatus: "pending",
              generatedAt: now.toISOString(),
              createdAt: now.toISOString(),
            },
          }),
        ),
        documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: incidentPk,
              sk: "INCIDENT#inc_e2e#EVIDENCE#evi_e2e",
              trace_id: "inc_e2e",
              itemType: "evidence",
              id: "evi_e2e",
              type: "metric_deviation",
              title: "Elevated latency",
              statement: "Latency is above the seeded baseline.",
              relation: "supports",
              strength: "strong",
              observedAt: now.toISOString(),
              source: "e2e",
              qualityStatus: "verified",
              coverageRatio: 1,
            },
          }),
        ),
      ]);

      const port = await freePort();
      apiUrl = `http://127.0.0.1:${port}`;
      api = spawn(process.execPath, ["dist/index.js"], {
        cwd: process.cwd(),
        env: liveApiChildEnvironment({
          endpoint,
          port,
          tableName,
          authSecret,
          cursorSecret,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      api.stdout.on("data", (chunk: Buffer) => {
        childOutput += chunk.toString();
      });
      api.stderr.on("data", (chunk: Buffer) => {
        childOutput += chunk.toString();
      });
      api.once("error", (error) => {
        childOutput += `spawn error: ${error.message}\n`;
      });
      await waitForApi(apiUrl);
    }, 60_000);

    afterAll(async () => {
      await cleanupLiveApiResources({
        stopApi,
        async deleteTable() {
          if (!tableCreated || !client) return;
          await client.send(new DeleteTableCommand({ TableName: tableName }), {
            abortSignal: AbortSignal.timeout(2_000),
          });
          tableCreated = false;
        },
        destroyClient() {
          if (documentClient) documentClient.destroy();
          else client?.destroy();
          documentClient = undefined;
          client = undefined;
        },
      });
    });

    it("serves the public runtime contract through real HTTP and repositories", async () => {
      const session = new SessionCodec(authSecret).issue({
        id: "usr_e2e",
        email: "engineer@example.test",
        name: "E2E Engineer",
        role: "engineer",
      });
      const cookie = `session=${encodeURIComponent(session)}`;

      for (const path of [
        "/api/v1/dashboard/overview",
        "/api/v1/incidents",
        "/api/v1/incidents/inc_e2e/diagnosis",
        "/api/v1/monitoring/overview",
        "/metrics",
        "/health",
      ]) {
        const response = await fetch(`${apiUrl}${path}`);
        expect(response.status, path).toBe(200);
      }

      const review = await fetch(
        `${apiUrl}/api/v1/incidents/inc_e2e/hypotheses/hyp_e2e/review`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            status: "confirmed",
            note: "Confirmed by live E2E.",
            expectedVersion: 0,
          }),
        },
      );
      expect(review.status).toBe(200);
      if (!documentClient)
        throw new Error("DynamoDB document client was not initialized");
      const persistedHypothesis = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: hypothesisKey }),
      );
      expect(persistedHypothesis.Item?.reviewVersion).toBe(1);

      const events = await fetch(`${apiUrl}/api/v1/incidents/inc_e2e/events`);
      expect(events.status).toBe(200);
      expect(await events.json()).toMatchObject({
        meta: {
          partial: true,
          warnings: [
            { code: "AGGREGATE_EVENTS_UNAVAILABLE" },
            { code: "INDIVIDUAL_EVENTS_UNAVAILABLE" },
          ],
        },
      });

      const individualEvent = await fetch(
        `${apiUrl}/api/v1/incidents/inc_e2e/events/evt_e2e`,
      );
      expect(individualEvent.status).toBe(503);
      expect(await individualEvent.json()).toMatchObject({
        error: { code: "DATA_UNAVAILABLE" },
      });

      const importBody = {
        fileName: "e2e.sql.gz",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        partCount: 1,
      };
      const unauthenticatedImport = await fetch(`${apiUrl}/api/v1/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(importBody),
      });
      expect(unauthenticatedImport.status).toBe(401);
      const authenticatedImport = await fetch(`${apiUrl}/api/v1/imports`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(importBody),
      });
      expect(authenticatedImport.status).toBe(503);
      expect(await authenticatedImport.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });

      const reanalysisHeaders = { "idempotency-key": "rea_e2e" };
      const unauthenticatedReanalysis = await fetch(
        `${apiUrl}/api/v1/incidents/inc_e2e/reanalyze`,
        { method: "POST", headers: reanalysisHeaders },
      );
      expect(unauthenticatedReanalysis.status).toBe(401);
      const authenticatedReanalysis = await fetch(
        `${apiUrl}/api/v1/incidents/inc_e2e/reanalyze`,
        {
          method: "POST",
          headers: { ...reanalysisHeaders, cookie },
        },
      );
      expect(authenticatedReanalysis.status).toBe(503);
      expect(await authenticatedReanalysis.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });

      const login = await fetch(`${apiUrl}/auth/login`, {
        redirect: "manual",
      });
      expect(login.status).toBe(503);
      expect(await login.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });
      const callback = await fetch(
        `${apiUrl}/auth/callback?code=code_e2e&state=state_e2e`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(503);
      expect(await callback.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });

      const unknown = await fetch(`${apiUrl}/unknown-e2e-path`, {
        headers: { "x-request-id": "req_live_missing" },
      });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("x-request-id")).toBe("req_live_missing");
      expect(await unknown.json()).toMatchObject({
        error: {
          code: "RESOURCE_NOT_FOUND",
          requestId: "req_live_missing",
        },
      });
    });
  },
);

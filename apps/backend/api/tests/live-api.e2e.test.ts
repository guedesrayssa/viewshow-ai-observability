import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
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

const tableName = "view-show-operacional-e2e";
const activeDatasetItem = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/active-dataset-v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const activeDatasetKey = { pk: "CONTROL#DATASET", sk: "ACTIVE" };
const hypothesisKey = {
  pk: "INC#inc_e2e",
  sk: "INCIDENT#inc_e2e#HYPOTHESIS#hyp_e2e",
};
// require-active-dataset.ts usa esta mensagem, e só ela, quando o ponteiro
// ACTIVE está ausente, ilegível ou fora do contrato consumido.
const absentPointerMessage =
  "Nenhuma versão ativa e compatível do dataset está disponível.";
const readSurface = [
  "/api/v1/dashboard/overview",
  "/api/v1/incidents",
  "/api/v1/incidents/inc_e2e/diagnosis",
  "/api/v1/incidents/inc_e2e/events",
  "/api/v1/incidents/inc_e2e/events/evt_e2e",
  "/api/v1/monitoring/overview",
];
const authSecret = "a".repeat(32);
const cursorSecret = "c".repeat(32);

function authenticatedReadHeaders(): Record<string, string> {
  const session = new SessionCodec(authSecret).issue({
    id: "usr_e2e_reader",
    email: "reader@example.test",
    name: "E2E Reader",
    role: "viewer",
  });
  return { cookie: `session=${encodeURIComponent(session)}` };
}

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

    it("fails closed with DATA_UNAVAILABLE while no dataset version is ACTIVE", async () => {
      if (!documentClient)
        throw new Error("DynamoDB document client was not initialized");
      // A ausência do ponteiro ACTIVE é o estado de partida, garantido aqui
      // para que o teste não dependa da ordem de execução do arquivo.
      await documentClient.send(
        new DeleteCommand({ TableName: tableName, Key: activeDatasetKey }),
      );

      for (const path of readSurface) {
        const response = await fetch(`${apiUrl}${path}`, {
          headers: authenticatedReadHeaders(),
        });
        expect(response.status, path).toBe(503);
        expect(await response.json(), path).toMatchObject({
          error: {
            code: "DATA_UNAVAILABLE",
            message: absentPointerMessage,
          },
        });
      }

      for (const path of ["/health", "/metrics"]) {
        const response = await fetch(`${apiUrl}${path}`);
        expect(response.status, path).toBe(200);
      }
    });

    it("keeps failing closed after a valid ACTIVE manifest, because no public projection exists yet", async () => {
      if (!documentClient)
        throw new Error("DynamoDB document client was not initialized");
      await documentClient.send(
        new PutCommand({ TableName: tableName, Item: activeDatasetItem }),
      );

      for (const path of readSurface) {
        const response = await fetch(`${apiUrl}${path}`, {
          headers: authenticatedReadHeaders(),
        });
        expect(response.status, path).toBe(503);
        const body = (await response.json()) as {
          readonly error: { readonly code: string; readonly message: string };
        };
        expect(body.error.code, path).toBe("DATA_UNAVAILABLE");
        // O manifesto foi realmente consumido: a recusa deixa de citar o
        // ponteiro ausente e passa a citar a projeção que ainda não existe.
        expect(body.error.message, path).not.toBe(absentPointerMessage);
      }
    });

    it("answers FEATURE_UNAVAILABLE for writes the active physical contract does not support", async () => {
      if (!documentClient)
        throw new Error("DynamoDB document client was not initialized");
      await documentClient.send(
        new PutCommand({ TableName: tableName, Item: activeDatasetItem }),
      );
      const session = new SessionCodec(authSecret).issue({
        id: "usr_e2e",
        email: "engineer@example.test",
        name: "E2E Engineer",
        role: "engineer",
      });
      const cookie = `session=${encodeURIComponent(session)}`;

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
      expect(review.status).toBe(503);
      expect(await review.json()).toMatchObject({
        error: { code: "FEATURE_UNAVAILABLE" },
      });
      // A recusa não pode deixar rastro: nenhuma revisão é materializada.
      const persistedHypothesis = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: hypothesisKey }),
      );
      expect(persistedHypothesis.Item).toBeUndefined();

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
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "import_e2e_invalid_legacy_body",
        },
        body: JSON.stringify(importBody),
      });
      expect(authenticatedImport.status).toBe(400);
      expect(await authenticatedImport.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
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
    });

    it("propagates the request id on an unknown path", async () => {
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

import { randomInt, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";

const shouldRun = process.env.RUN_LIVE_AWS === "true";
const apiUrl = process.env.LIVE_AWS_API_URL?.replace(/\/$/, "");
const panelUrl = process.env.LIVE_AWS_PANEL_URL?.replace(/\/$/, "");
const username = process.env.LIVE_AWS_USERNAME;
const password = process.env.LIVE_AWS_PASSWORD;
const region = process.env.AWS_REGION ?? "us-east-1";
const operationalTable = process.env.LIVE_AWS_OPERATIONAL_TABLE;
const importBucket = process.env.LIVE_AWS_IMPORT_BUCKET;

let sessionCookie = "";
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });

type ImportPayload = {
  fileName: string;
  sizeBytes: number;
  snapshotExtractedOn: string;
};

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function recoverImportId(
  payload: ImportPayload,
  startedAt: number,
): Promise<string | null> {
  if (!operationalTable) return null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const matches: string[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await dynamo.send(
        new QueryCommand({
          TableName: operationalTable,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": "IMPORTS" },
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const record of page.Items ?? []) {
        if (
          typeof record.importId === "string" &&
          record.fileName === payload.fileName &&
          record.sizeBytes === payload.sizeBytes &&
          record.snapshotExtractedOn === payload.snapshotExtractedOn &&
          typeof record.createdAt === "string" &&
          Date.parse(record.createdAt) >= startedAt - 300_000
        )
          matches.push(record.importId);
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    if (matches.length > 1)
      throw new Error(
        "Mais de uma importação corresponde à tentativa do teste.",
      );
    if (matches[0]) return matches[0];
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function cleanupImport(importId: string): Promise<void> {
  if (!operationalTable) return;
  const recordKey = { pk: "IMPORTS", sk: `IMPORT#${importId}` };
  const record = await dynamo.send(
    new GetCommand({
      TableName: operationalTable,
      Key: recordKey,
      ConsistentRead: true,
    }),
  );
  const key = record.Item?.key;
  const uploadId = record.Item?.uploadId;
  let abortError: unknown;
  if (importBucket && typeof key === "string" && typeof uploadId === "string") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: importBucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
        abortError = undefined;
        break;
      } catch (error) {
        abortError = error;
      }
    }
  }

  await dynamo
    .send(
      new DeleteCommand({
        TableName: operationalTable,
        Key: { pk: "CONTROL#IMPORT", sk: "ACTIVE" },
        ConditionExpression: "importId = :importId",
        ExpressionAttributeValues: { ":importId": importId },
      }),
    )
    .catch((error: unknown) => {
      if (
        (error as { name?: string }).name !== "ConditionalCheckFailedException"
      )
        throw error;
    });
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const mappings = await dynamo.send(
      new ScanCommand({
        TableName: operationalTable,
        ProjectionExpression: "pk, sk, importId",
        FilterExpression: "importId = :importId AND begins_with(pk, :prefix)",
        ExpressionAttributeValues: {
          ":importId": importId,
          ":prefix": "IMPORT_IDEMPOTENCY#",
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of mappings.Items ?? []) {
      if (typeof item.pk !== "string" || typeof item.sk !== "string") continue;
      await dynamo.send(
        new DeleteCommand({
          TableName: operationalTable,
          Key: { pk: item.pk, sk: item.sk },
          ConditionExpression: "importId = :importId",
          ExpressionAttributeValues: { ":importId": importId },
        }),
      );
    }
    exclusiveStartKey = mappings.LastEvaluatedKey;
  } while (exclusiveStartKey);
  await dynamo.send(
    new DeleteCommand({
      TableName: operationalTable,
      Key: recordKey,
      ConditionExpression: "importId = :importId",
      ExpressionAttributeValues: { ":importId": importId },
    }),
  );
  if (abortError)
    throw new Error(
      `O multipart ${uploadId} em ${key} não pôde ser abortado após três tentativas.`,
      { cause: abortError },
    );
}

describe.skipIf(!shouldRun)("integração da aplicação implantada na AWS", () => {
  beforeAll(async () => {
    if (
      !apiUrl ||
      !panelUrl ||
      !username ||
      !password ||
      !operationalTable ||
      !importBucket
    ) {
      throw new Error(
        "RUN_LIVE_AWS=true exige URLs, usuário/senha, LIVE_AWS_OPERATIONAL_TABLE e LIVE_AWS_IMPORT_BUCKET",
      );
    }

    const login = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    const match = login.headers.get("set-cookie")?.match(/session=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    sessionCookie = match?.[1] ?? "";
  }, 30_000);

  it("IT-AWS-01: Amplify e API Gateway/EKS entregam o painel e o health check", async () => {
    const [panel, health] = await Promise.all([
      fetch(`${panelUrl}/dados/importacoes/`),
      fetch(`${apiUrl}/health`),
    ]);

    expect(panel.status).toBe(200);
    expect(panel.headers.get("content-type")).toContain("text/html");
    expect(await panel.text()).toContain("View Show");
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toMatchObject({ status: "ok" });
  });

  it("IT-AWS-02: a guarda HTTP bloqueia a consulta de sessão sem cookie", async () => {
    const response = await fetch(`${apiUrl}/auth/session`);

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("IT-AWS-03: Cognito, API, caso de uso e DynamoDB entregam a mesma projeção", async () => {
    const startedAt = performance.now();
    const response = await fetch(
      `${apiUrl}/api/v1/incidents?window=24h&limit=5`,
      {
        headers: {
          cookie: `session=${sessionCookie}`,
          "x-request-id": `req_it_incidents_${Date.now()}`,
        },
      },
    );
    const body = await responseJson(response);
    const responseMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { page: { limit: 5 } } });
    const items = (body.data as { items: { id?: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toMatch(/\"(?:pk|sk|ttl|trace_id)\"/);

    const manifest = await dynamo.send(
      new GetCommand({
        TableName: operationalTable,
        Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
        ConsistentRead: true,
      }),
    );
    const datasetVersion = manifest.Item?.activeDatasetVersion;
    expect(typeof datasetVersion).toBe("string");
    const projection = await dynamo.send(
      new GetCommand({
        TableName: operationalTable,
        Key: {
          pk: `DATASET#${datasetVersion as string}#VIEW#INCIDENTS#ACTIVE`,
          sk: "CURRENT",
        },
        ConsistentRead: true,
      }),
    );
    const projectedItems = (
      projection.Item?.payload as
        { incidents?: { incidentId?: string }[] } | undefined
    )?.incidents;
    expect(projectedItems?.length).toBeGreaterThan(0);
    const projectedIds = new Set(
      projectedItems?.map((item) => item.incidentId),
    );
    for (const item of items) expect(projectedIds.has(item.id)).toBe(true);
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);

    console.info(
      JSON.stringify({
        evidence: "IT-AWS-03",
        requestId: response.headers.get("x-request-id"),
        responseMs: Number(responseMs.toFixed(2)),
        itemCount: items.length,
        datasetVersion,
        projectionItemCount: projectedItems?.length,
        physicalFieldsExposed: false,
      }),
    );
  });

  it("IT-AWS-04: rota de dashboard lê as projeções semeadas no DynamoDB", async () => {
    const response = await fetch(
      `${apiUrl}/api/v1/dashboard/overview?window=24h`,
      {
        headers: { cookie: `session=${sessionCookie}` },
      },
    );
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(JSON.stringify(body.data)).not.toMatch(/\"(?:pk|sk|ttl)\"/);
  });

  it("IT-AWS-05: API reserva a importação no DynamoDB e prepara multipart real no S3", async () => {
    const activeBefore = await dynamo.send(
      new GetCommand({
        TableName: operationalTable,
        Key: { pk: "CONTROL#IMPORT", sk: "ACTIVE" },
        ConsistentRead: true,
      }),
    );
    expect(activeBefore.Item).toBeUndefined();

    const idempotencyKey = `it-aws-${randomUUID()}`;
    const requestId = `req_it_import_${Date.now()}`;
    const payload = {
      fileName: "argus_dump.sql.gz",
      sizeBytes: randomInt(1, 1_000_000),
      snapshotExtractedOn: "2026-09-25",
    };
    let importId = "";
    const requestStartedAt = Date.now();
    const startedAt = performance.now();
    try {
      const started = await fetch(`${apiUrl}/api/v1/imports`, {
        method: "POST",
        headers: {
          cookie: `session=${sessionCookie}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-request-id": requestId,
        },
        body: JSON.stringify(payload),
      });
      const startedBody = await responseJson(started);
      expect(started.status).toBe(201);
      importId = (startedBody.data as { importId: string }).importId;
      expect(startedBody).toMatchObject({
        data: { importId, state: "UPLOADING", sizeBytes: payload.sizeBytes },
      });
      expect(started.headers.get("x-request-id")).toBe(requestId);

      const record = await dynamo.send(
        new GetCommand({
          TableName: operationalTable,
          Key: { pk: "IMPORTS", sk: `IMPORT#${importId}` },
          ConsistentRead: true,
        }),
      );
      expect(record.Item).toMatchObject({
        importId,
        state: "UPLOADING",
        fileName: payload.fileName,
        sizeBytes: payload.sizeBytes,
        bucket: importBucket,
      });
      expect(record.Item?.uploadId).toEqual(expect.any(String));
      expect(record.Item?.key).toBe(`staging/imports/${importId}/source`);

      const uploads = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: importBucket,
          Prefix: `staging/imports/${importId}/source`,
        }),
      );
      const matchingUploads = (uploads.Uploads ?? []).filter(
        (upload) =>
          upload.Key === record.Item?.key &&
          upload.UploadId === record.Item?.uploadId,
      );
      expect(matchingUploads).toHaveLength(1);

      const replay = await fetch(`${apiUrl}/api/v1/imports`, {
        method: "POST",
        headers: {
          cookie: `session=${sessionCookie}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(replay.status).toBe(201);
      expect(await responseJson(replay)).toMatchObject({ data: { importId } });

      const conflict = await fetch(`${apiUrl}/api/v1/imports`, {
        method: "POST",
        headers: {
          cookie: `session=${sessionCookie}`,
          "content-type": "application/json",
          "idempotency-key": `it-aws-conflict-${randomUUID()}`,
        },
        body: JSON.stringify(payload),
      });
      expect(conflict.status).toBe(409);
      expect(await responseJson(conflict)).toMatchObject({
        error: { code: "IMPORT_IN_PROGRESS", details: { importId } },
      });

      console.info(
        JSON.stringify({
          evidence: "IT-AWS-05",
          requestId,
          responseMs: Number((performance.now() - startedAt).toFixed(2)),
          importId,
          dynamoState: record.Item?.state,
          s3Key: record.Item?.key,
          multipartUploads: matchingUploads.length,
          replayReturnedSameImport: true,
          concurrentStartStatus: 409,
        }),
      );
    } finally {
      const createdImportId =
        importId || (await recoverImportId(payload, requestStartedAt));
      if (createdImportId) await cleanupImport(createdImportId);
    }

    const activeAfterCleanup = await dynamo.send(
      new GetCommand({
        TableName: operationalTable,
        Key: { pk: "CONTROL#IMPORT", sk: "ACTIVE" },
        ConsistentRead: true,
      }),
    );
    expect(activeAfterCleanup.Item).toBeUndefined();
  }, 60_000);
});

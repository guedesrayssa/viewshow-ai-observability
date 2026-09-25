/**
 * IT02 (Seção 2 de artefatos/sprint4/testes-funcionais.md): `IncidentUseCases`
 * + `DynamoIncidentRepository` contra um DynamoDB Local **real** — não o
 * `client.send` inteiramente mockado de `tests/dynamodb-adapters.test.ts`,
 * nem só a chamada avulsa que `tests/live-api.e2e.test.ts` faz a
 * `/api/v1/incidents`. Aqui a paginação em si (`CursorCodec` real, offset
 * decodificado, união de páginas) é exercitada contra `Query` genuíno do
 * DynamoDB, na camada de aplicação — sem HTTP, sem `createApp()`.
 *
 * Reusa o guarda de segurança de `scripts/live-e2e-runtime.mjs`
 * (`requireDynamoDbEndpoint`): só aceita endpoint local
 * (`127.0.0.1`/`localhost`/`http://dynamodb:8000` em CI), nunca a AWS real.
 * Mesmo `RUN_LIVE_E2E=true` de `tests/live-api.e2e.test.ts` — é a mesma
 * família de teste "contra DynamoDB Local de verdade", só numa camada
 * diferente.
 *
 * USO (a partir de apps/backend/api/loadtest/../.. == apps/backend/api):
 *   bash ../../scripts/tests/test-dynamodb-real-local.sh
 * ou manualmente, com um DynamoDB Local já rodando:
 *   RUN_LIVE_E2E=true DYNAMODB_ENDPOINT=http://127.0.0.1:<porta> \
 *     AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
 *     npm test -- tests/dynamodb-real.integration.test.ts
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { incidentsQuerySchema } from "@view-show/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireDynamoDbEndpoint } from "../scripts/live-e2e-runtime.mjs";
import { DynamoIncidentRepository } from "../src/modules/incidents/adapters/dynamodb-incident-repository.js";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "../src/modules/incidents/application/incident-use-cases.js";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.js";

const tableName = "monitoracao-operacional-it02";
const TOTAL_INCIDENTS = 25;
const PAGE_LIMIT = 7;

let client: DynamoDBClient | undefined;
let useCases: IncidentUseCases | undefined;
let tableCreated = false;

describe.skipIf(process.env.RUN_LIVE_E2E !== "true")(
  "IT02 — IncidentUseCases x DynamoDB Local real (Query genuíno, não mockado)",
  () => {
    beforeAll(async () => {
      const endpoint = requireDynamoDbEndpoint(process.env);
      client = new DynamoDBClient({
        region: "us-east-1",
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      });
      const documentClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });

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

      // Todos os incidentes no mesmo bucket de hora — listBetween() consulta
      // por hora truncada (ver dynamodb-incident-repository.ts), então um
      // único bucket já exercita a paginação real sem depender de quantos
      // buckets a janela varre.
      const now = new Date();
      const hourBucket = `INC#${now.toISOString().slice(0, 13)}`;
      await Promise.all(
        Array.from({ length: TOTAL_INCIDENTS }, (_, index) => {
          const id = `inc-it02-${String(index + 1).padStart(3, "0")}`;
          return documentClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                pk: hourBucket,
                sk: `INCIDENT#${id}`,
                trace_id: id,
                itemType: "incident",
                id,
                title: `Incidente de integração ${index + 1}`,
                priority: "P3",
                status: "investigating",
                // Espalhado por segundo pra ordenação "recent" ser
                // determinística entre as duas páginas.
                startedAt: new Date(now.getTime() - index * 1000).toISOString(),
                affectedDevices: 100 + index,
                affectedSessions: 150 + index,
                deviceType: "Web",
              },
            }),
          );
        }),
      );

      const repository = new DynamoIncidentRepository(
        "us-east-1",
        tableName,
        documentClient,
      );
      useCases = new IncidentUseCases(
        repository,
        new CursorCodec("it02-test-secret-32-characters!!"),
        new UnavailableReviewFeedbackPort(),
      );
    }, 30_000);

    afterAll(async () => {
      if (tableCreated)
        await client
          ?.send(new DeleteTableCommand({ TableName: tableName }))
          .catch(() => undefined);
      client?.destroy();
    });

    it("pagina sem duplicar nem pular itens gravados em um DynamoDB real", async () => {
      if (!useCases) throw new Error("setup did not run");

      const seenIds = new Set<string>();
      let cursor: string | undefined;
      let hasMore = true;
      let pages = 0;

      while (hasMore) {
        pages += 1;
        if (pages > TOTAL_INCIDENTS)
          throw new Error("paginação não convergiu — possível loop infinito");

        const query = incidentsQuerySchema.parse({
          window: "24h",
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        const response = await useCases.list(query);

        for (const item of response.data.items) {
          expect(seenIds.has(item.id)).toBe(false);
          seenIds.add(item.id);
          // Nenhum campo físico de persistência (pk/sk/trace_id/itemType)
          // deve vazar no DTO devolvido pela camada de aplicação.
          expect(item).not.toHaveProperty("pk");
          expect(item).not.toHaveProperty("sk");
          expect(item).not.toHaveProperty("trace_id");
          expect(item).not.toHaveProperty("itemType");
        }
        expect(response.data.items.length).toBeLessThanOrEqual(PAGE_LIMIT);

        hasMore = response.data.page.hasMore;
        cursor = response.data.page.nextCursor ?? undefined;
        if (!hasMore) expect(response.data.page.nextCursor).toBeNull();
      }

      expect(seenIds.size).toBe(TOTAL_INCIDENTS);
      expect(pages).toBe(Math.ceil(TOTAL_INCIDENTS / PAGE_LIMIT));
    });

    it("rejeita um cursor obtido sob um filtro quando reenviado com outro", async () => {
      if (!useCases) throw new Error("setup did not run");

      const original = await useCases.list(
        incidentsQuerySchema.parse({
          window: "24h",
          deviceType: "Web",
          limit: PAGE_LIMIT,
        }),
      );
      expect(original.data.page.nextCursor).not.toBeNull();

      await expect(
        useCases.list(
          incidentsQuerySchema.parse({
            window: "24h",
            region: "Sudeste",
            limit: PAGE_LIMIT,
            cursor: original.data.page.nextCursor ?? undefined,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  },
);

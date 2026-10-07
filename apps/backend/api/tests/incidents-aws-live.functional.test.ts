/**
 * CT-01 a CT-12 (Seção 3 de artefatos/sprint4/testes-funcionais.md) executados
 * como requisições HTTP reais contra a API implantada na AWS (ALB → ECS
 * Fargate → DynamoDB), não contra um `createApp()` local nem um repositório
 * fake. Precondições:
 *
 *   - stack `apps/fullstack` aplicada nesta conta/sessão do Learner Lab;
 *   - tabela operacional semeada com `node scripts/seed-carga.cjs
 *     ALLOW_REMOTE_SEED=1 OPERATIONAL_TABLE_NAME=<tabela>` (mesmo formato de
 *     item que `dynamodb-incident-repository.ts` espera — nenhum campo
 *     inventado);
 *   - um usuário Cognito de teste no User Pool da stack, criado via
 *     `aws cognito-idp admin-create-user` + `admin-set-user-password
 *     --permanent` (login por senha real, POST /auth/login — não forja
 *     cookie).
 *
 * Só roda com RUN_AWS_FUNCTIONAL=true; sem isso (inclusive em `npm test`
 * comum) o describe inteiro é pulado e nenhuma chamada de rede acontece.
 */
import { beforeAll, describe, expect, it } from "vitest";

const shouldRun = process.env.RUN_AWS_FUNCTIONAL === "true";

const baseUrl = process.env.AWS_API_BASE_URL;
const username = process.env.AWS_TEST_USERNAME;
const password = process.env.AWS_TEST_PASSWORD;

type IncidentsResponse = {
  readonly data: {
    readonly items: readonly Record<string, unknown>[];
    readonly page: {
      readonly limit: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  };
};

type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly {
      readonly field: string;
      readonly message: string;
    }[];
  };
};

let sessionCookie = "";

async function login(): Promise<string> {
  if (!baseUrl || !username || !password)
    throw new Error(
      "RUN_AWS_FUNCTIONAL=true exige AWS_API_BASE_URL, AWS_TEST_USERNAME e AWS_TEST_PASSWORD",
    );
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200)
    throw new Error(
      `login falhou: ${response.status} ${await response.text()}`,
    );
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/session=([^;]+)/);
  if (!match)
    throw new Error(`login não devolveu cookie de sessão: ${setCookie}`);
  return match[1];
}

async function getIncidents(
  query: Record<string, string>,
  { withSession = true }: { withSession?: boolean } = {},
): Promise<{ status: number; body: IncidentsResponse | ErrorResponse }> {
  const url = new URL(`${baseUrl}/api/v1/incidents`);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: withSession ? { Cookie: `session=${sessionCookie}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

function assertNoPhysicalFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPhysicalFields(entry);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      expect(["pk", "sk", "ttl", "trace_id"]).not.toContain(key);
      assertNoPhysicalFields(entry);
    }
  }
}

describe.skipIf(!shouldRun)(
  "GET /api/v1/incidents — casos de uso e valor limite (AWS real, Seção 3)",
  () => {
    beforeAll(async () => {
      sessionCookie = await login();
    }, 30_000);

    it("CT-01: fluxo principal — window=1h sem limit usa o default 20", async () => {
      const { status, body } = await getIncidents({ window: "1h" });
      expect(status).toBe(200);
      const data = (body as IncidentsResponse).data;
      expect(data.page.limit).toBe(20);
      expect(data.items.length).toBeLessThanOrEqual(20);
      assertNoPhysicalFields(data.items);
    });

    it("CT-02: A1 — paginação subsequente não repete itens da primeira página", async () => {
      const first = await getIncidents({ window: "6h", limit: "5" });
      expect(first.status).toBe(200);
      const firstData = (first.body as IncidentsResponse).data;
      expect(firstData.page.hasMore).toBe(true);
      expect(firstData.page.nextCursor).not.toBeNull();

      const second = await getIncidents({
        window: "6h",
        limit: "5",
        cursor: firstData.page.nextCursor as string,
      });
      expect(second.status).toBe(200);
      const secondData = (second.body as IncidentsResponse).data;

      const firstIds = new Set(firstData.items.map((item) => item.id));
      for (const item of secondData.items)
        expect(firstIds.has(item.id)).toBe(false);
    });

    it("CT-03: A2 — janela absoluta (from/to) sem window", async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 2 * 60 * 60 * 1000);
      const { status, body } = await getIncidents({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      expect(status).toBe(200);
      const data = (body as IncidentsResponse).data;
      for (const item of data.items) {
        const startedAt = new Date(item.startedAt as string).getTime();
        expect(startedAt).toBeGreaterThanOrEqual(from.getTime());
        expect(startedAt).toBeLessThanOrEqual(to.getTime());
      }
    });

    it("CT-04: A3 — filtro por deviceType (única dimensão suportada por vez) + limit=50", async () => {
      const { status, body } = await getIncidents({
        window: "24h",
        deviceType: "Mobile",
        limit: "50",
      });
      expect(status).toBe(200);
      const data = (body as IncidentsResponse).data;
      expect(data.page.limit).toBe(50);
      for (const item of data.items) {
        const scopeSummary = item.scopeSummary as {
          dimension: string;
          value: string;
        }[];
        const deviceType = scopeSummary.find(
          (scope) => scope.dimension === "deviceType",
        );
        expect(deviceType?.value).toBe("Mobile");
      }
    });

    it("CT-05: limit=1 (extremo inferior válido)", async () => {
      const { status, body } = await getIncidents({ window: "1h", limit: "1" });
      expect(status).toBe(200);
      const data = (body as IncidentsResponse).data;
      expect(data.page.limit).toBe(1);
      expect(data.items.length).toBeLessThanOrEqual(1);
    });

    it("CT-06: limit=0 (abaixo do mínimo) é rejeitado antes de qualquer consulta", async () => {
      const { status, body } = await getIncidents({ window: "1h", limit: "0" });
      expect(status).toBe(400);
      expect((body as ErrorResponse).error.code).toBe("VALIDATION_ERROR");
    });

    it("CT-07: limit=100 (extremo superior válido)", async () => {
      const { status, body } = await getIncidents({
        window: "24h",
        limit: "100",
      });
      expect(status).toBe(200);
      const data = (body as IncidentsResponse).data;
      expect(data.page.limit).toBe(100);
      expect(data.items.length).toBeLessThanOrEqual(100);
    });

    it("CT-08: limit=101 (acima do máximo) é rejeitado", async () => {
      const { status, body } = await getIncidents({
        window: "1h",
        limit: "101",
      });
      expect(status).toBe(400);
      expect((body as ErrorResponse).error.code).toBe("VALIDATION_ERROR");
    });

    it("CT-09: limit=abc (tipo inválido) é rejeitado", async () => {
      const { status, body } = await getIncidents({
        window: "1h",
        limit: "abc",
      });
      expect(status).toBe(400);
      expect((body as ErrorResponse).error.code).toBe("VALIDATION_ERROR");
    });

    it("CT-10: E1 — window e from/to juntos são rejeitados", async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const { status, body } = await getIncidents({
        window: "1h",
        from: from.toISOString(),
        to: to.toISOString(),
      });
      expect(status).toBe(400);
      const error = (body as ErrorResponse).error;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.fields?.map((field) => field.message)).toContainEqual(
        expect.stringContaining("from e to devem ser enviados juntos"),
      );
    });

    it("CT-11: E2 — cursor obtido com um filtro é rejeitado sob outro filtro", async () => {
      const original = await getIncidents({
        window: "24h",
        deviceType: "Mobile",
        limit: "5",
      });
      const originalData = (original.body as IncidentsResponse).data;
      expect(originalData.page.nextCursor).not.toBeNull();

      const { status, body } = await getIncidents({
        window: "24h",
        deviceType: "Web",
        limit: "5",
        cursor: originalData.page.nextCursor as string,
      });
      expect(status).toBe(400);
      const error = (body as ErrorResponse).error;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toBe("O cursor é inválido para estes filtros.");
    });

    it("CT-12: E4 — sem sessão a rota responde 401 antes de qualquer validação", async () => {
      const { status, body } = await getIncidents(
        { window: "1h" },
        { withSession: false },
      );
      expect(status).toBe(401);
      expect((body as ErrorResponse).error.code).toBe("UNAUTHENTICATED");
    });
  },
);

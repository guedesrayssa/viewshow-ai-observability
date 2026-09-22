/**
 * @file client.test.ts
 * A origem do estado "indisponível".
 *
 * `overview-view.test.tsx` já confirma que a Visão Geral reage certo a um
 * recurso com `source: "indisponivel"` — mas parte de um mock que já entrega
 * esse shape pronto. Falta o outro lado: quando a leitura **de fato rejeita**
 * (API fora do ar, timeout, 5xx, corpo ilegível), `composeResource` tem que
 * capturar a falha e **resolver** — nunca rejeitar — com um recurso sem `data`
 * e `availability: "unavailable"`. Se `composeResource` propagasse a rejeição,
 * ou devolvesse outro shape, o hook não sairia de "loading" e a tela ficaria
 * presa no espaço reservado.
 *
 * A API operacional precisa estar apontada por variável de ambiente, senão
 * `composeResource` curto-circuita em `API_NOT_CONFIGURED` antes de chamar
 * `read` e o `catch` nunca é exercitado. A base é lida uma única vez na carga
 * do módulo, então o stub vai em `vi.hoisted`, que roda antes dos imports.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  // O padrão já é proibido, mas deixa explícito: sem conjunto de exemplo, a
  // falha vira estado de indisponível, não número.
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "false");
});

import {
  ApiError,
  apiRequest,
  composeResource,
  isApiConfigured,
  loadResource,
} from "@/lib/data/client";
import { WARNINGS } from "@/lib/data/warnings";

afterAll(() => {
  vi.unstubAllEnvs();
});

/** Formato qualquer para o parâmetro de tipo; nenhum teste chega a preenchê-lo. */
type Bloco = { value: number };

describe("composeResource — captura da falha na origem", () => {
  it("enxerga a API operacional configurada neste ambiente de teste", () => {
    // Guarda: sem isto os testes abaixo passariam por curto-circuito em
    // API_NOT_CONFIGURED, sem nunca entrar no `try/catch` do `read`.
    expect(isApiConfigured()).toBe(true);
  });

  it("resolve — não rejeita — quando `read` lança, e devolve um recurso sem dado", async () => {
    const promise = composeResource<Bloco>({
      read: async () => {
        throw new ApiError(
          "A API respondeu 503 em /api/v1/dashboard/overview.",
          503,
        );
      },
    });

    await expect(promise).resolves.toBeDefined();

    const resource = await promise;
    expect(resource.data).toBeUndefined();
    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.fetchedAt).toBeInstanceOf(Date);
  });

  it("captura rejeição de promise, não só `throw` síncrono", async () => {
    const resource = await composeResource<Bloco>({
      read: () => Promise.reject(new ApiError("A API não respondeu em 8s.")),
    });

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
  });

  it("carrega o aviso READ_FAILED com a mensagem do erro real e o registra em fallbackReason", async () => {
    const resource = await composeResource<Bloco>({
      read: async () => {
        throw new Error("conexão recusada");
      },
    });

    const readFailed = resource.warnings.find(
      (warning) => warning.code === WARNINGS.leituraFalhou.code,
    );
    expect(readFailed).toBeDefined();
    expect(readFailed?.message).toBe("conexão recusada");
    expect(resource.fallbackReason).toBe("conexão recusada");
  });

  it("cai para a mensagem padrão de READ_FAILED quando o que foi lançado não é um Error", async () => {
    const resource = await composeResource<Bloco>({
      read: () => Promise.reject("explodiu sem ser Error"),
    });

    const readFailed = resource.warnings.find(
      (warning) => warning.code === WARNINGS.leituraFalhou.code,
    );
    expect(readFailed?.message).toBe(WARNINGS.leituraFalhou.message);
    expect(resource.source).toBe("indisponivel");
  });

  it("preserva os avisos declarados na leitura ao lado do READ_FAILED", async () => {
    const resource = await composeResource<Bloco>({
      warnings: [WARNINGS.semLinhaDeBase],
      read: async () => {
        throw new ApiError("timeout");
      },
    });

    const codes = resource.warnings.map((warning) => warning.code);
    expect(codes).toContain(WARNINGS.leituraFalhou.code);
    expect(codes).toContain(WARNINGS.semLinhaDeBase.code);
  });

  // O `catch` não pode ser seletivo por tipo de erro: seja timeout, 5xx, queda
  // de rede ou JSON malformado, o resultado tem que ser o mesmo recurso
  // indisponível.
  it.each([
    [
      "timeout (ApiError sem status)",
      new ApiError("A API não respondeu em 8s."),
    ],
    [
      "5xx (ApiError com status 503)",
      new ApiError("A API respondeu 503 em /x.", 503),
    ],
    ["queda de rede (TypeError)", new TypeError("Failed to fetch")],
    [
      "JSON malformado (SyntaxError)",
      new SyntaxError("Unexpected end of JSON input"),
    ],
  ])(
    "normaliza para indisponível seja qual for a falha: %s",
    async (_label, erro) => {
      const resource = await composeResource<Bloco>({
        read: async () => {
          throw erro;
        },
      });

      expect(resource.source).toBe("indisponivel");
      expect(resource.availability).toBe("unavailable");
      expect(resource.data).toBeUndefined();
      expect(
        resource.warnings.some(
          (warning) => warning.code === WARNINGS.leituraFalhou.code,
        ),
      ).toBe(true);
    },
  );
});

describe("loadResource + apiGet — falhas reais de transporte", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function comFetch(impl: () => Promise<unknown>) {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  async function lerOverview() {
    return loadResource<{ stats: [] }, { stats: [] }>({
      path: "/api/v1/dashboard/overview",
      map: (response) => response,
    });
  }

  it("queda de rede — fetch rejeita com TypeError — vira recurso indisponível", async () => {
    comFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const resource = await lerOverview();

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
    const readFailed = resource.warnings.find(
      (warning) => warning.code === WARNINGS.leituraFalhou.code,
    );
    expect(readFailed?.message).toContain("Failed to fetch");
  });

  it("resposta 5xx — fetch resolve com ok:false — vira recurso indisponível", async () => {
    comFetch(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as unknown as Response),
    );

    const resource = await lerOverview();

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    const readFailed = resource.warnings.find(
      (warning) => warning.code === WARNINGS.leituraFalhou.code,
    );
    expect(readFailed?.message).toContain("503");
  });

  it("corpo ilegível — response.json() rejeita — vira recurso indisponível", async () => {
    comFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      } as unknown as Response),
    );

    const resource = await lerOverview();

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
  });
});

const gatewayMeta = {
  requestId: "req_test",
  schemaVersion: "1.0",
  datasetVersion: null,
  generatedAt: "2026-09-17T10:00:00.000Z",
  window: null,
  partial: false,
  refreshAfterSeconds: null,
  freshness: [],
  warnings: [],
};

describe("apiRequest — mutações autenticadas e canceláveis", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("serializa JSON, cookies e idempotência somente quando informados", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { state: "UPLOADING" }, meta: gatewayMeta }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest<{ state: string }>("/api/v1/imports", {
        method: "POST",
        json: {},
        idempotencyKey: "start-strong-key",
      }),
    ).resolves.toEqual({
      data: { state: "UPLOADING" },
      meta: gatewayMeta,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      credentials: "include",
      cache: "no-store",
    });
    expect(new Headers(init.headers)).toEqual(expect.objectContaining({}));
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "start-strong-key",
    );
  });

  it("codifica query de GET sem body, content-type ou idempotência", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { items: [] }, meta: gatewayMeta }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/v1/imports", {
      params: { limit: 25, cursor: "page/one + two" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("limit=25");
    expect(url).toContain("cursor=page%2Fone+%2B+two");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.has("Idempotency-Key")).toBe(false);
  });

  it("preserva o envelope de erro estruturado sem registrar detalhes", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "IMPORT_IN_PROGRESS",
              message: "Já existe uma importação em andamento.",
              requestId: "req_conflict",
              fields: [{ field: "fileName", code: "invalid", message: "x" }],
              details: { importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3" },
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = await apiRequest("/api/v1/imports").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "IMPORT_IN_PROGRESS",
      requestId: "req_conflict",
      fields: [{ field: "fileName", code: "invalid", message: "x" }],
      details: { importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3" },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("envia sessão expirada ao login preservando a rota atual", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      origin: "http://dashboard.test",
      pathname: "/dados/importacoes/",
      search: "?origem=menu",
      hash: "#historico",
      assign,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "UNAUTHENTICATED",
              message: "Sessão inválida.",
              requestId: "req_expired",
            },
          }),
          { status: 401 },
        ),
      ),
    );

    await expect(apiRequest("/api/v1/imports")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(assign).toHaveBeenCalledWith(
      "http://dashboard.test/login?returnTo=%2Fdados%2Fimportacoes%2F%3Forigem%3Dmenu%23historico",
    );
  });

  it("propaga cancelamento externo ao fetch sem classificá-lo como timeout", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const request = apiRequest("/api/v1/imports", {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const cancelled = expect(request).rejects.toMatchObject({
      name: "ApiError",
      message: "A solicitação foi cancelada.",
    });

    controller.abort();

    await cancelled;
  });

  it("aborta o fetch no timeout e limpa o timer", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    const request = apiRequest("/api/v1/imports", { timeoutMs: 25 });
    const timedOut = expect(request).rejects.toMatchObject({
      name: "ApiError",
      message: "O gateway excedeu o tempo limite.",
    });
    await vi.advanceTimersByTimeAsync(25);

    await timedOut;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mantém timeout como a primeira causa mesmo se o signal externo abortar depois", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (reason: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );
    const controller = new AbortController();
    const request = apiRequest("/api/v1/imports", {
      signal: controller.signal,
      timeoutMs: 25,
    });

    vi.advanceTimersByTime(25);
    controller.abort();
    rejectFetch(new DOMException("aborted", "AbortError"));

    await expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejeita sucesso fora do envelope e aceita 204 explicitamente", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "UPLOADING" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/api/v1/imports")).rejects.toMatchObject({
      name: "ApiError",
      code: "INVALID_API_RESPONSE",
    });
    await expect(
      apiRequest("/auth/logout", { method: "POST", expectNoContent: true }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["requestId vazio", { ...gatewayMeta, requestId: "" }],
    ["schema version divergente", { ...gatewayMeta, schemaVersion: "2.0" }],
    ["dataset version inválida", { ...gatewayMeta, datasetVersion: "latest" }],
    ["timestamp inválido", { ...gatewayMeta, generatedAt: "hoje" }],
    ["refresh zero", { ...gatewayMeta, refreshAfterSeconds: 0 }],
    ["refresh fracionário", { ...gatewayMeta, refreshAfterSeconds: 1.5 }],
    [
      "window incompleta",
      {
        ...gatewayMeta,
        window: { preset: null, from: gatewayMeta.generatedAt },
      },
    ],
    [
      "freshness inválida",
      {
        ...gatewayMeta,
        freshness: [
          {
            source: "argus",
            observedThrough: gatewayMeta.generatedAt,
            lagSeconds: -1,
            state: "fresh",
          },
        ],
      },
    ],
    [
      "warning inválido",
      { ...gatewayMeta, warnings: [{ code: "", message: "missing" }] },
    ],
    ["campo extra", { ...gatewayMeta, physicalKey: "secret" }],
  ])("rejeita meta fora do contrato público: %s", async (_label, meta) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: {}, meta }), { status: 200 }),
        ),
    );

    await expect(apiRequest("/api/v1/imports")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("aceita todos os campos aninhados válidos do responseMetaSchema", async () => {
    const meta = {
      ...gatewayMeta,
      datasetVersion: `dsv_${"a".repeat(64)}`,
      window: {
        preset: "30m",
        from: "2026-09-17T09:30:00-03:00",
        to: "2026-09-17T10:00:00-03:00",
      },
      refreshAfterSeconds: 5,
      freshness: [
        {
          source: "argus",
          observedThrough: "2026-09-17T10:00:00.123Z",
          lagSeconds: 0,
          state: "fresh",
        },
      ],
      warnings: [{ code: "PARTIAL", message: "Dados parciais" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { ok: true }, meta }), {
          status: 200,
        }),
      ),
    );

    await expect(apiRequest("/api/v1/imports")).resolves.toEqual({
      data: { ok: true },
      meta,
    });
  });
});

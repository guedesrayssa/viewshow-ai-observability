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
 * As duas APIs precisam estar apontadas por variável de ambiente, senão
 * `composeResource` curto-circuita em `API_NOT_CONFIGURED` antes de chamar
 * `read` e o `catch` nunca é exercitado. `API_BASES` é lido uma única vez, na
 * carga do módulo, então o stub vai em `vi.hoisted`, que roda antes dos imports.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  vi.stubEnv("NEXT_PUBLIC_TELEMETRY_API_BASE_URL", "http://telemetria.test");
  // O padrão já é proibido, mas deixa explícito: sem conjunto de exemplo, a
  // falha vira estado de indisponível, não número.
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "false");
});

import {
  ApiError,
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
  it("enxerga as duas APIs como configuradas neste ambiente de teste", () => {
    // Guarda: sem isto os testes abaixo passariam por curto-circuito em
    // API_NOT_CONFIGURED, sem nunca entrar no `try/catch` do `read`.
    expect(isApiConfigured("operacional")).toBe(true);
    expect(isApiConfigured("telemetria")).toBe(true);
  });

  it("resolve — não rejeita — quando `read` lança, e devolve um recurso sem dado", async () => {
    const promise = composeResource<Bloco>({
      targets: ["operacional"],
      read: async () => {
        throw new ApiError("A API respondeu 503 em /api/v1/dashboard/summary.", 503);
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
      targets: ["operacional"],
      read: () => Promise.reject(new ApiError("A API não respondeu em 8s.")),
    });

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
  });

  it("carrega o aviso READ_FAILED com a mensagem do erro real e o registra em fallbackReason", async () => {
    const resource = await composeResource<Bloco>({
      targets: ["operacional"],
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
      targets: ["operacional"],
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
      targets: ["telemetria"],
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
    ["timeout (ApiError sem status)", new ApiError("A API não respondeu em 8s.")],
    ["5xx (ApiError com status 503)", new ApiError("A API respondeu 503 em /x.", 503)],
    ["queda de rede (TypeError)", new TypeError("Failed to fetch")],
    ["JSON malformado (SyntaxError)", new SyntaxError("Unexpected end of JSON input")],
  ])("normaliza para indisponível seja qual for a falha: %s", async (_label, erro) => {
    const resource = await composeResource<Bloco>({
      targets: ["operacional"],
      read: async () => {
        throw erro;
      },
    });

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
    expect(
      resource.warnings.some((warning) => warning.code === WARNINGS.leituraFalhou.code),
    ).toBe(true);
  });
});

describe("loadResource + apiGet — falhas reais de transporte", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function comFetch(impl: () => Promise<unknown>) {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  async function lerResumo() {
    return loadResource<{ stats: [] }, { stats: [] }>({
      target: "operacional",
      path: "/api/v1/dashboard/summary",
      map: (response) => response,
    });
  }

  it("queda de rede — fetch rejeita com TypeError — vira recurso indisponível", async () => {
    comFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const resource = await lerResumo();

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

    const resource = await lerResumo();

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

    const resource = await lerResumo();

    expect(resource.source).toBe("indisponivel");
    expect(resource.availability).toBe("unavailable");
    expect(resource.data).toBeUndefined();
  });
});

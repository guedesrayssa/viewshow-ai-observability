/**
 * @file use-resource.test.ts
 * O ciclo de vida da leitura no caminho de erro.
 *
 * O achado do P1 era a tela presa em skeleton quando a API operacional falha.
 * A raiz está aqui: se `useResource` não saísse de `"loading"` ao receber um
 * recurso indisponível — o que `composeResource` devolve ao capturar uma falha
 * —, a tela nunca trocaria o espaço reservado pelo estado de indisponível,
 * ainda que a leitura já tivesse uma resposta utilizável.
 *
 * Cobre os dois desfechos que não podem ficar presos em `"loading"`:
 * - `load` **resolve** com um recurso sem dado  → `status: "ready"`
 * - `load` **rejeita** de fato                  → `status: "error"`
 */

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Resource } from "@/lib/data/client";
import { useResource } from "@/hooks/use-resource";

/** O que `composeResource` devolve ao capturar uma falha de leitura. */
function recursoIndisponivel(): Resource<{ value: number }> {
  return {
    source: "indisponivel",
    availability: "unavailable",
    warnings: [{ code: "READ_FAILED", message: "A API operacional não respondeu." }],
    fetchedAt: new Date(),
    fallbackReason: "A API operacional não respondeu.",
  };
}

describe("useResource — não fica preso em loading no caminho de erro", () => {
  it("sai de 'loading' para 'ready' quando load resolve com recurso sem dado", async () => {
    const { result } = renderHook(() =>
      useResource(() => Promise.resolve(recursoIndisponivel()), []),
    );

    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.status).not.toBe("loading");
    expect(result.current.data).toBeUndefined();
    expect(result.current.availability).toBe("unavailable");
    expect(result.current.source).toBe("indisponivel");
    expect(result.current.refreshing).toBe(false);
  });

  it("vai para 'error' — não fica em 'loading' — quando load rejeita de fato", async () => {
    const { result } = renderHook(() =>
      useResource<{ value: number }>(
        () => Promise.reject(new Error("rede caiu")),
        [],
      ),
    );

    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.status).not.toBe("loading");
    expect(result.current.error).toBe("rede caiu");
    expect(result.current.data).toBeUndefined();
  });

  it("usa a mensagem padrão quando a rejeição não é um Error", async () => {
    const { result } = renderHook(() =>
      useResource<{ value: number }>(() => Promise.reject("sem ser Error"), []),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Não foi possível ler a telemetria.");
  });
});

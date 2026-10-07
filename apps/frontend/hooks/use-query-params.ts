/**
 * @file use-query-params.ts
 * Filtros, ordenação e página guardados na URL.
 *
 * Recarregar a tela, voltar no navegador ou mandar o link para alguém da
 * equipe precisa reproduzir o mesmo recorte. Por isso o estado das listas mora
 * na query string, e não só na memória do componente.
 *
 * `update` recebe todas as mudanças de uma vez: chamadas seguidas no mesmo
 * clique leriam a mesma URL de partida e uma apagaria a outra.
 */

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export type QueryPatch = Record<string, string | null | undefined>;

export function useQueryParams() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const update = useCallback(
    (patch: QueryPatch) => {
      const current =
        typeof window === "undefined"
          ? searchParams.toString()
          : window.location.search;
      const params = new URLSearchParams(current);

      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }

      const search = params.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  /** Lê um parâmetro aceitando só os valores previstos; o resto vira o padrão. */
  const read = useCallback(
    <T extends string>(
      key: string,
      fallback: T,
      allowed?: readonly T[],
    ): T => {
      const value = searchParams.get(key);
      if (value === null) return fallback;
      if (allowed && !allowed.includes(value as T)) return fallback;
      return value as T;
    },
    [searchParams],
  );

  return { searchParams, read, update };
}

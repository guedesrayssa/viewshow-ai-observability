/**
 * @file resource-state.ts
 * Leitura que falhou, distinta de leitura vazia.
 *
 * `loadResource` não lança: quando o gateway falha, devolve o recurso com
 * `source: "indisponivel"` e o motivo em `warnings`. Sem esta checagem, as
 * telas liam "sem dado" como "nenhum incidente" ou ficavam presas no
 * esqueleto de carregamento.
 */

import type { UseResourceResult } from "@/hooks/use-resource";

export function resourceFailed(resource: Pick<UseResourceResult<unknown>, "status" | "source" | "data">): boolean {
  if (resource.status === "error") return true;
  return resource.status === "ready" && resource.source === "indisponivel" && resource.data === undefined;
}

export function resourceFailureMessage(
  resource: Pick<UseResourceResult<unknown>, "error" | "warnings">,
  fallback: string,
): string {
  return resource.error ?? resource.warnings[0]?.message ?? fallback;
}

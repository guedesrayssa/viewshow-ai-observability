/**
 * @file use-resource.ts
 * Ciclo de vida de um dado do painel na tela.
 *
 * Cobre os quatro estados que toda tela de telemetria precisa mostrar:
 * esperando, com dado, atualizando e sem conseguir ler. A tela recebe os
 * quatro prontos e decide o que desenhar em cada um — é o que separa um painel
 * que informa de um painel que só exibe números fixos.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DataSource, Resource } from "@/lib/data/client";

/** Estado da leitura. */
export type ResourceStatus = "loading" | "ready" | "error";

export type UseResourceResult<T> = {
  data?: T;
  status: ResourceStatus;
  /** Verdadeiro durante uma releitura, com o dado anterior ainda na tela. */
  refreshing: boolean;
  error?: string;
  source?: DataSource;
  fetchedAt?: Date;
  /** Motivo da queda para o conjunto de exemplo, quando houve uma. */
  fallbackReason?: string;
  /** Número de leituras concluídas. Serve de semente ao dado de exemplo. */
  revision: number;
  refresh: () => void;
};

export type UseResourceOptions = {
  /** Intervalo de releitura automática, em milissegundos. */
  refreshMs?: number;
  /** Desliga a leitura, para dependências que ainda não estão prontas. */
  enabled?: boolean;
};

/**
 * Lê um recurso do painel e mantém o estado da leitura.
 *
 * @param load - Função que devolve o recurso. Recebe o número da revisão, para
 * que o conjunto de exemplo possa variar entre atualizações.
 * @param deps - Valores que, ao mudar, disparam nova leitura (filtros,
 * período, recorte).
 *
 * @example
 * const incidents = useResource(
 *   (revision) => fetchIncidents({ period }, revision),
 *   [period],
 *   { refreshMs: 30_000 },
 * );
 */
export function useResource<T>(
  load: (revision: number) => Promise<Resource<T>>,
  deps: readonly unknown[],
  { refreshMs, enabled = true }: UseResourceOptions = {},
): UseResourceResult<T> {
  const [state, setState] = useState<{
    data?: T;
    status: ResourceStatus;
    error?: string;
    source?: DataSource;
    fetchedAt?: Date;
    fallbackReason?: string;
  }>({ status: "loading" });

  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);

  // A função de leitura costuma ser uma arrow criada no corpo do componente:
  // guardá-la em ref evita que a identidade nova a cada render vire um laço.
  // A atualização acontece em um efeito declarado antes do de leitura, que é a
  // ordem em que os dois rodam.
  const loadRef = useRef(load);
  const hasDataRef = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    if (hasDataRef.current) setRefreshing(true);

    loadRef.current(revision).then(
      (resource) => {
        if (!active) return;
        hasDataRef.current = true;
        setRefreshing(false);
        setState({
          data: resource.data,
          status: "ready",
          source: resource.source,
          fetchedAt: resource.fetchedAt,
          fallbackReason: resource.fallbackReason,
        });
      },
      (error: unknown) => {
        if (!active) return;
        setRefreshing(false);
        setState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível ler a telemetria.",
        }));
      },
    );

    return () => {
      active = false;
    };
    // `deps` é a lista declarada pela tela; `revision` cobre as releituras
    // manual e automática.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, revision, ...deps]);

  const refresh = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!refreshMs || !enabled) return;

    const id = setInterval(() => setRevision((current) => current + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, enabled]);

  return { ...state, refreshing, revision, refresh };
}

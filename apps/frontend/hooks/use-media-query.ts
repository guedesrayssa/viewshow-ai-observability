/**
 * @file use-media-query.ts
 * Leitura reativa de uma media query.
 *
 * Usa `useSyncExternalStore` porque a media query é estado que vive fora do
 * React: o valor é lido direto do navegador na renderização do cliente e
 * assinado para as mudanças seguintes, sem o vaivém de um efeito que corrige o
 * estado depois da primeira pintura.
 *
 * No servidor a resposta é sempre `false`, o valor conservador: nenhuma
 * decisão de layout depende disso antes da hidratação.
 */

"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Informa se a media query casa com o ambiente atual.
 *
 * @param query - Media query, como `(prefers-color-scheme: dark)`.
 *
 * @example
 * const isDark = useMediaQuery("(prefers-color-scheme: dark)");
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * @file use-reduced-motion.ts
 * Preferência de movimento do sistema operacional.
 *
 * O CSS já respeita `prefers-reduced-motion` sozinho. Este hook existe para o
 * movimento escrito em JavaScript — contagem de números, desenho progressivo —
 * que precisa saltar direto para o valor final em vez de animar.
 */

"use client";

import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * Informa se a pessoa usuária pediu menos movimento.
 *
 * @returns `true` quando o sistema está configurado para reduzir animações.
 *
 * @example
 * const reduced = useReducedMotion();
 * const duration = reduced ? 0 : 900;
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

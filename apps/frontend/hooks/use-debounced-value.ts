/**
 * @file use-debounced-value.ts
 * Valor que só muda depois de um intervalo sem novas alterações.
 *
 * Usado nas buscas que vão à API: a digitação atualiza o campo na hora, mas a
 * leitura só parte quando a pessoa para de digitar.
 */

"use client";

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

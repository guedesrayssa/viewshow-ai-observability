/**
 * @file use-element-size.ts
 * Tamanho renderizado de um elemento.
 *
 * Os gráficos precisam desenhar em coordenadas reais, e não em um `viewBox`
 * esticado: `preserveAspectRatio="none"` faz o traço servir a qualquer largura,
 * mas distorce junto os rótulos e a espessura das linhas. Medir o contêiner
 * resolve isso e ainda permite decidir quantos rótulos cabem no eixo.
 */

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export type ElementSize = { width: number; height: number };

/**
 * Observa o tamanho de um elemento.
 *
 * @returns A referência a aplicar no elemento e o tamanho medido. Antes da
 * primeira medição, o tamanho é zero — quem desenha deve esperar por ele.
 *
 * @example
 * const [ref, { width }] = useElementSize<HTMLDivElement>();
 * return <div ref={ref}>{width > 0 ? <Chart width={width} /> : null}</div>;
 */
export function useElementSize<T extends HTMLElement>(): [
  RefObject<T | null>,
  ElementSize,
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;
      // Arredondar evita um novo render a cada fração de pixel durante o
      // arrasto da borda da janela.
      setSize((current) => {
        const next = { width: Math.round(width), height: Math.round(height) };
        return current.width === next.width && current.height === next.height
          ? current
          : next;
      });
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

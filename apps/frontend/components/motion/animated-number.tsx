/**
 * @file animated-number.tsx
 * Número que conta até o valor atual.
 *
 * Usado nos indicadores do painel. A contagem não é enfeite: ela mostra que
 * aquele número acabou de ser lido da telemetria e diferencia um dado que
 * chegou agora de um que já estava na tela. Quando o valor muda — a cada
 * atualização do painel — a contagem parte do número anterior, e não do zero,
 * para que a variação seja percebida no tamanho do salto.
 */

"use client";

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/cn";

/** Duração da contagem, em milissegundos. */
const DURATION = 900;

/** Desaceleração no fim, para o número "assentar" no valor final. */
function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

export type AnimatedNumberProps = {
  /** Valor a exibir. */
  value: number;
  /** Formata o número a cada quadro. Recebe o valor intermediário. */
  format?: (value: number) => string;
  /** Texto exibido antes do número. */
  prefix?: string;
  /** Texto exibido depois do número, como a unidade. */
  suffix?: string;
  className?: string;
};

/**
 * Número animado do valor anterior até o atual.
 *
 * @example
 * <AnimatedNumber value={342} suffix="/min" />
 * <AnimatedNumber value={12400} format={(n) => n.toLocaleString("pt-BR")} />
 */
export function AnimatedNumber({
  value,
  format = (current) => Math.round(current).toLocaleString("pt-BR"),
  prefix,
  suffix,
  className,
}: AnimatedNumberProps) {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;

    if (reducedMotion || from === to) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    let frame = 0;
    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION);
      setDisplay(from + (to - from) * easeOutCubic(progress));

      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reducedMotion]);

  return (
    // O valor final fica no atributo para que o leitor de tela anuncie o número
    // pronto, sem acompanhar cada quadro da contagem.
    <span
      className={cn("tabular-nums", className)}
      aria-label={`${prefix ?? ""}${format(value)}${suffix ?? ""}`}
    >
      <span aria-hidden="true">
        {prefix}
        {format(display)}
        {suffix}
      </span>
    </span>
  );
}

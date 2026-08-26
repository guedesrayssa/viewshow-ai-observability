/**
 * @file reveal.tsx
 * Entrada de conteúdo na tela.
 *
 * Envolve um bloco e o revela quando ele chega à área visível. É o único
 * mecanismo de entrada da aplicação: cartões, gráficos, linhas de tabela e
 * cabeçalhos usam o mesmo componente, com o mesmo tempo e a mesma curva, para
 * que a interface inteira se mova como uma peça só.
 *
 * A cascata é feita pela prop `delay` (ou por `index`, que a calcula a partir
 * de um passo fixo). Nada aqui roda quando a pessoa usuária pede menos
 * movimento: o CSS zera a duração e o conteúdo simplesmente aparece.
 */

"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

/** Forma da entrada. */
export type RevealVariant = "rise" | "rise-sm" | "fade" | "scale" | "slide";

const VARIANT_CLASSES: Record<RevealVariant, string> = {
  rise: "animate-rise",
  "rise-sm": "animate-rise-sm",
  fade: "animate-fade-in",
  scale: "animate-scale-in",
  slide: "animate-slide-in-left",
};

/** Passo padrão da cascata, em milissegundos. */
export const STAGGER_STEP = 70;

export type RevealProps = {
  children: ReactNode;
  /** Elemento renderizado. Use `li`, `tr` ou `section` conforme o contexto. */
  as?: ElementType;
  variant?: RevealVariant;
  /** Atraso em milissegundos. Tem prioridade sobre `index`. */
  delay?: number;
  /** Posição na cascata. O atraso vira `index * STAGGER_STEP`. */
  index?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * Revela um bloco quando ele entra na tela.
 *
 * @example
 * <Reveal index={2}><StatCard {...stat} /></Reveal>
 */
export function Reveal({
  children,
  as: Tag = "div",
  variant = "rise",
  delay,
  index = 0,
  className,
  style,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Sem suporte a IntersectionObserver, mostra tudo de uma vez: a animação é
    // um refinamento, não pode ser condição para ler a tela. O quadro de
    // espera evita atualizar o estado dentro do próprio efeito.
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      // Sem margem de folga: qualquer pixel visível já revela o bloco. Uma
      // margem negativa embaixo deixaria escondido para sempre o conteúdo que
      // cai na borda inferior de uma página que não tem o que rolar.
      { threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const computedDelay = delay ?? index * STAGGER_STEP;

  return (
    <Tag
      ref={ref}
      data-reveal={shown ? "shown" : "hidden"}
      className={cn(shown && VARIANT_CLASSES[variant], className)}
      style={
        shown && computedDelay > 0
          ? { ...style, animationDelay: `${computedDelay}ms` }
          : style
      }
    >
      {children}
    </Tag>
  );
}

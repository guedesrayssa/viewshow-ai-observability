/**
 * @file wordmark.tsx
 * Letreiro do View Show.
 *
 * É o logotipo textual da marca, vetorizado a partir do arquivo entregue pelo
 * time de design (`assets/view-show-letreiro-branco.svg`). Substitui a palavra
 * "View Show" escrita em Poppins que a interface usava antes: o letreiro tem
 * proporções e recortes próprios que a tipografia do sistema não reproduz.
 *
 * O desenho herda a cor do texto por `currentColor`, então a mesma peça serve
 * ao tema claro, ao tema escuro e ao fundo navy da navegação. A estrela do "O"
 * é um recorte de máscara, e não uma forma pintada: assim ela deixa passar o
 * gradiente que estiver atrás em vez de carregar uma cor de fundo fixa.
 */

"use client";

import { useId } from "react";

import { cn } from "@/lib/cn";

/** Proporção do arquivo original (1144 × 441). */
const VIEW_WIDTH = 1144;
const VIEW_HEIGHT = 441;
const ASPECT = VIEW_WIDTH / VIEW_HEIGHT;

/**
 * Blocos do letreiro, na ordem da leitura (esquerda para a direita, primeira
 * linha antes da segunda). A ordem importa: é ela que define a cascata da
 * animação de entrada.
 */
const LETTER_BLOCKS: string[] = [
  // VIEW
  "M369 0H408V130H369L239 0H294.25L369 74.75V0Z",
  "M467 0H428V130H467V0Z",
  "M526 0H487V130H526V0Z",
  "M578 0H526V30H578V0Z",
  "M578 50H526V80H578V50Z",
  "M578 100H526V130H578V100Z",
  "M637 0H598V130H637L674.375 92.625V130H711.75L841.75 0L786.5 0.000488281L711.75 74.75V37.375H674.375L637 74.75V0Z",
  // SHOW
  "M216 181H100V257H216V181Z",
  "M100 181H0V349H100V181Z",
  "M116 273H100V349H116V273Z",
  "M216 273H116V441H216V273Z",
  "M116 365H0V441H116V365Z",
  "M348 181H248V441H348V181Z",
  "M364 273H348V349H364V273Z",
  "M464 181H364V441H464V181Z",
  "M712 181H496V441H712V181Z",
  "M844 181H744V441H844V181Z",
  "M744 441H843.956L994 181H894.044L744 441Z",
  "M994 181H894V441H994V181Z",
  "M894 441H993.956L1144 181H1044.04L894 441Z",
];

/** Estrela de quatro pontas vazada no "O" de SHOW. */
const STAR_PATH =
  "M604 203L623.849 291.151L712 311L623.849 330.849L604 419L584.151 330.849L496 311L584.151 291.151L604 203Z";

export type WordmarkProps = {
  /** Altura do letreiro em pixels. A largura acompanha a proporção original. */
  height?: number;
  /**
   * Revela os blocos em cascata na montagem. Reservado para a abertura de uma
   * tela — na navegação, que fica na tela o tempo todo, o letreiro entra
   * inteiro.
   */
  animated?: boolean;
  className?: string;
};

/**
 * Logotipo textual da marca.
 *
 * @example
 * <Wordmark height={28} />
 * <Wordmark height={64} animated />
 */
export function Wordmark({
  height = 28,
  animated = false,
  className,
}: WordmarkProps) {
  // Duas instâncias na mesma página não podem compartilhar o id da máscara,
  // ou a segunda recorta a primeira.
  const maskId = useId();

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      width={Math.round(height * ASPECT)}
      height={height}
      role="img"
      aria-label="View Show"
      className={cn("shrink-0", className)}
    >
      <defs>
        <mask id={maskId}>
          <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#fff" />
          <path d={STAR_PATH} fill="#000" />
        </mask>
      </defs>

      <g fill="currentColor" mask={`url(#${maskId})`}>
        {LETTER_BLOCKS.map((path, index) => (
          <path
            key={path}
            d={path}
            className={animated ? "animate-rise-sm" : undefined}
            style={
              animated ? { animationDelay: `${60 + index * 32}ms` } : undefined
            }
          />
        ))}
      </g>
    </svg>
  );
}

/**
 * @file logo.tsx
 * Marca do View Show.
 *
 * Reproduz em SVG o símbolo documentado na seção 7.2 do entendimento de UX:
 * estrela de quatro pontas sobre elipse navy, dentro de um círculo de marca.
 * As três aplicações do manual estão disponíveis pela prop `tone`.
 */

import { cn } from "@/lib/cn";
import { Wordmark } from "@/components/ui/wordmark";

/**
 * Cores fixas do símbolo.
 *
 * A marca não acompanha o tema: o branco do brilho central e o navy da elipse
 * são os mesmos do manual em qualquer superfície.
 */
const BRAND_WHITE = "#ffffff";
const BRAND_NAVY = "#101b46";

/** Aplicações da marca previstas no manual. */
export type LogoTone = "brand" | "gradient" | "mono";

type LogoMarkProps = {
  /** Aplicação da marca. `gradient` é a usada no login e na navegação. */
  tone?: LogoTone;
  /** Lado do símbolo, em pixels. */
  size?: number;
  className?: string;
};

/**
 * Símbolo isolado da marca, sem o logotipo textual.
 *
 * @example
 * <LogoMark tone="gradient" size={96} />
 */
export function LogoMark({
  tone = "brand",
  size = 40,
  className,
}: LogoMarkProps) {
  // O gradiente precisa de um id único por instância para não colidir quando
  // dois símbolos são renderizados na mesma página.
  const gradientId = `logo-gradient-${tone}-${size}`;
  const circleFill =
    tone === "gradient"
      ? `url(#${gradientId})`
      : tone === "mono"
        ? BRAND_NAVY
        : "var(--color-brand-red)";
  // A elipse e a estrela usam as cores fixas da marca, e não os tokens de
  // superfície: no tema escuro, `surface` é navy e a estrela desaparecia dentro
  // da elipse — justamente o brilho que dá nome ao símbolo.
  const lozengeFill = tone === "mono" ? BRAND_WHITE : BRAND_NAVY;
  const starFill = tone === "mono" ? BRAND_NAVY : BRAND_WHITE;

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="View Show"
      className={cn("shrink-0", className)}
    >
      {tone === "gradient" ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-brand-orange)" />
            <stop offset="55%" stopColor="var(--color-brand-red)" />
            <stop offset="100%" stopColor="var(--color-brand-red-deep)" />
          </linearGradient>
        </defs>
      ) : null}

      <circle cx="32" cy="32" r="25.9" fill={circleFill} />
      <ellipse cx="32" cy="32" rx="17.6" ry="9.6" fill={lozengeFill} />

      {/* O brilho de quatro pontas ultrapassa a elipse no eixo vertical, como
          na aplicação do manual. */}
      <path
        d="M32 12Q33.4 30.6 52 32Q33.4 33.4 32 52Q30.6 33.4 12 32Q30.6 30.6 32 12Z"
        fill={starFill}
      />
    </svg>
  );
}

type LogoProps = LogoMarkProps & {
  /** Orientação do logotipo em relação ao símbolo. */
  orientation?: "horizontal" | "vertical";
  /** Exibe o logotipo textual ao lado do símbolo. */
  withWordmark?: boolean;
  /** Revela o letreiro em cascata na montagem. Use na abertura de uma tela. */
  animated?: boolean;
};

/**
 * Marca completa: símbolo e letreiro.
 *
 * O letreiro é o SVG entregue pelo design (`Wordmark`), e não mais a palavra
 * "View Show" composta na tipografia do sistema.
 *
 * @example
 * <Logo tone="gradient" size={32} />
 */
export function Logo({
  tone = "brand",
  size = 32,
  orientation = "horizontal",
  withWordmark = true,
  animated = false,
  className,
}: LogoProps) {
  if (!withWordmark) {
    return <LogoMark tone={tone} size={size} className={className} />;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center",
        orientation === "vertical" ? "flex-col gap-3" : "flex-row gap-3",
        tone === "mono" ? "text-brand-navy" : "text-current",
        className,
      )}
    >
      <LogoMark tone={tone} size={size} />
      {/* 0,58 do símbolo mantém o letreiro alinhado à altura do desenho da
          estrela, como na aplicação horizontal do manual. */}
      <Wordmark height={Math.round(size * 0.58)} animated={animated} />
    </span>
  );
}

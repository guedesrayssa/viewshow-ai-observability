/**
 * @file logo.tsx
 * Marca do View Show.
 *
 * Reproduz em SVG o símbolo documentado na seção 7.2 do entendimento de UX:
 * estrela de quatro pontas sobre elipse navy, dentro de um círculo de marca.
 * As três aplicações do manual estão disponíveis pela prop `tone`.
 */

import { cn } from "@/lib/cn";

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
        ? "var(--color-brand-navy)"
        : "var(--color-brand-red)";
  const lozengeFill =
    tone === "mono" ? "var(--color-surface)" : "var(--color-brand-navy)";
  const starFill =
    tone === "mono" ? "var(--color-brand-navy)" : "var(--color-surface)";

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
      <path
        d="M32 17.9Q32 32 46.1 32Q32 32 32 46.1Q32 32 17.9 32Q32 32 32 17.9Z"
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
};

/**
 * Marca completa: símbolo e logotipo textual.
 *
 * @example
 * <Logo tone="gradient" size={32} />
 */
export function Logo({
  tone = "brand",
  size = 32,
  orientation = "horizontal",
  withWordmark = true,
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
        className,
      )}
    >
      <LogoMark tone={tone} size={size} />
      <span
        className={cn(
          "font-semibold tracking-tight",
          tone === "mono" ? "text-brand-navy" : "text-current",
        )}
        style={{ fontSize: Math.round(size * 0.44) }}
      >
        View Show
      </span>
    </span>
  );
}

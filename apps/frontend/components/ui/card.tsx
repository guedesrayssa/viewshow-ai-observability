/**
 * @file card.tsx
 * Cartão de conteúdo.
 *
 * É a superfície padrão para agrupar dados no View Show: fundo branco, borda
 * de 1 px e raio de 16 px, conforme a prancha "Foundations". A faixa de
 * destaque (`accent`) reproduz o realce lateral dos cartões de KPI.
 */

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/** Cor da faixa de destaque do cartão. */
export type CardAccent = "none" | "critical" | "warning" | "info" | "brand";

const ACCENT_CLASSES: Record<CardAccent, string> = {
  none: "",
  critical: "before:bg-critical",
  warning: "before:bg-brand-orange",
  info: "before:bg-brand-blue-light",
  brand: "before:bg-gradient-brand",
};

/** Cor da borda do cartão. `critical` marca uma zona de risco, como excluir a conta. */
export type CardBorderTone = "line" | "critical";

const BORDER_CLASSES: Record<CardBorderTone, string> = {
  line: "border-line",
  critical: "border-critical",
};

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  accent?: CardAccent;
  /** Posição da faixa de destaque. */
  accentPosition?: "left" | "top";
  /** Cor da borda do cartão. */
  borderTone?: CardBorderTone;
  /** Espaçamento interno. `none` deixa o preenchimento por conta do conteúdo. */
  padding?: "none" | "sm" | "md" | "lg";
};

const PADDING_CLASSES = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
} as const;

/**
 * Superfície de agrupamento de conteúdo.
 *
 * @example
 * <Card accent="critical"><CardTitle>Taxa de erros</CardTitle></Card>
 */
export function Card({
  accent = "none",
  accentPosition = "left",
  borderTone = "line",
  padding = "md",
  className,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card border bg-surface shadow-card",
        BORDER_CLASSES[borderTone],
        accent !== "none" && "before:absolute before:content-['']",
        accent !== "none" &&
          (accentPosition === "left"
            ? "before:inset-y-0 before:left-0 before:w-1"
            : "before:inset-x-0 before:top-0 before:h-1"),
        ACCENT_CLASSES[accent],
        PADDING_CLASSES[padding],
        className,
      )}
      {...props}
    />
  );
}

/** Título do cartão. */
export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-title text-ink", className)} {...props} />;
}

/** Descrição de apoio do cartão, sempre abaixo do título. */
export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-caption text-brand-blue", className)}
      {...props}
    />
  );
}

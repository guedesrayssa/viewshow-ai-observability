/**
 * @file badge.tsx
 * Selo de estado.
 *
 * Comunica severidade, prioridade e qualidade de fonte. O texto é obrigatório
 * e a cor é sempre acompanhada dele, atendendo ao princípio de redundância
 * semântica das WCAG 2.2: nenhuma informação depende apenas da cor.
 */

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/** Significado do selo. */
export type BadgeTone =
  | "critical"
  | "warning"
  | "success"
  | "info"
  | "neutral"
  | "brand";

const TONE_CLASSES: Record<BadgeTone, string> = {
  critical: "bg-critical-soft text-critical-strong",
  warning: "bg-warning-soft text-warning-strong",
  success: "bg-success-soft text-success-strong",
  info: "bg-info-soft text-ink-brand",
  neutral: "bg-canvas text-ink-muted",
  brand: "bg-gradient-brand text-ink-inverse",
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  critical: "bg-critical",
  warning: "bg-warning",
  success: "bg-success",
  info: "bg-info",
  neutral: "bg-ink-subtle",
  brand: "bg-ink-inverse",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** Exibe o ponto colorido antes do texto. */
  withDot?: boolean;
};

/**
 * Selo textual de estado.
 *
 * @example
 * <Badge tone="critical" withDot>Crítico</Badge>
 */
export function Badge({
  tone = "neutral",
  withDot = false,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1",
        "text-caption font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {withDot ? (
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 rounded-pill", DOT_CLASSES[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}

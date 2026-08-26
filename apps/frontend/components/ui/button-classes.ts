/**
 * @file button-classes.ts
 * Aparência do botão do design system, sem componente.
 *
 * Vive em um módulo próprio, sem `"use client"`, para que telas renderizadas
 * no servidor possam dar aparência de botão a um `Link` sem arrastar o
 * componente cliente junto.
 *
 * @see `components/ui/button.tsx` para o componente `Button`.
 */

import { cn } from "@/lib/cn";

/** Hierarquia visual da ação. */
export type ButtonVariant =
  | "gradient"
  | "solid"
  | "outline"
  | "ghost"
  | "quiet"
  | "danger";

/** Altura e densidade do botão. */
export type ButtonSize = "sm" | "md" | "lg";

export const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Ação primária da tela. Uma por área de decisão, para não competir.
  gradient:
    "bg-gradient-brand text-ink-inverse shadow-brand hover:brightness-[1.06] active:brightness-95",
  // Ação de navegação e confirmações secundárias em contexto de dados.
  solid: "bg-brand-blue text-ink-inverse hover:bg-brand-blue-dark",
  // Ação alternativa sobre superfícies claras.
  outline:
    "border border-line-strong bg-surface text-ink hover:bg-surface-muted active:bg-line-subtle",
  // Ação textual de apoio, com peso de link.
  ghost: "text-ink-brand hover:bg-brand-blue-soft",
  // Ação terciária, discreta, para cancelar ou descartar.
  quiet: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  // Ação destrutiva. Fica em contorno, e não no gradiente da ação primária:
  // excluir não é o caminho esperado da tela, é a saída de emergência dela.
  danger:
    "border border-critical bg-surface text-critical-strong hover:bg-critical-soft",
};

export const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-10 gap-1.5 px-3 text-caption",
  md: "h-12 gap-2 px-4 text-body-sm",
  lg: "h-13 gap-2 px-5 text-body",
};

/**
 * Classes visuais de um botão, para reaproveitar a aparência em um elemento
 * que não pode ser um `<button>` — como um `Link` de navegação.
 *
 * @example
 * <Link href="/incidentes" className={buttonClasses({ variant: "outline", size: "sm" })}>
 */
export function buttonClasses({
  variant = "gradient",
  size = "md",
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center rounded-field font-semibold",
    "transition-[filter,background-color,color,border-color,transform] duration-200",
    "active:scale-[0.98]",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? "w-full" : undefined,
    className,
  );
}

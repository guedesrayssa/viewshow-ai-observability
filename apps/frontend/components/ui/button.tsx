/**
 * @file button.tsx
 * Botão do design system.
 *
 * Cobre as variantes desenhadas na prancha de componentes do Figma: ação
 * primária em gradiente, ação sólida em azul de marca, contorno neutro e
 * botões de texto. Toda ação da interface deve usar este componente para
 * manter altura, raio, foco e estados consistentes entre as telas.
 */

"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { SpinnerIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/** Hierarquia visual da ação. */
export type ButtonVariant =
  | "gradient"
  | "solid"
  | "outline"
  | "ghost"
  | "quiet";

/** Altura e densidade do botão. */
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Ação primária da tela. Uma por área de decisão, para não competir.
  gradient:
    "bg-gradient-brand text-ink-inverse shadow-brand hover:brightness-[1.06] active:brightness-95",
  // Ação de navegação e confirmações secundárias em contexto de dados.
  solid: "bg-brand-blue text-ink-inverse hover:bg-brand-blue-dark",
  // Ação alternativa sobre superfícies claras.
  outline:
    "border border-line-strong bg-surface text-ink hover:bg-canvas active:bg-line-subtle",
  // Ação textual de apoio, com peso de link.
  ghost: "text-brand-blue hover:bg-brand-blue-soft",
  // Ação terciária, discreta, para cancelar ou descartar.
  quiet: "text-ink-muted hover:bg-canvas hover:text-ink",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3 text-caption",
  md: "h-11 gap-2 px-4 text-body-sm",
  lg: "h-12 gap-2 px-5 text-body-sm",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ocupa toda a largura disponível do contêiner. */
  fullWidth?: boolean;
  /**
   * Exibe o indicador de progresso e bloqueia novos envios. O rótulo continua
   * visível para que a pessoa usuária não perca o contexto da ação.
   */
  loading?: boolean;
  /** Elemento exibido antes do rótulo. */
  leadingIcon?: ReactNode;
  /** Elemento exibido depois do rótulo. */
  trailingIcon?: ReactNode;
};

/**
 * Classes visuais de um botão, para reaproveitar a aparência em um elemento
 * que não pode ser um `<button>` — como um `Link` de navegação.
 *
 * @example
 * <Link href="/incidentes/1" className={buttonClasses({ variant: "outline", size: "sm" })}>
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
    "transition-[filter,background-color,color,border-color] duration-150",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth && "w-full",
    className,
  );
}

/**
 * Botão de ação.
 *
 * @example
 * <Button variant="gradient" fullWidth loading={enviando}>Entrar</Button>
 */
export function Button({
  variant = "gradient",
  size = "md",
  fullWidth = false,
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      // `aria-busy` avisa o leitor de tela de que a ação está em andamento;
      // `disabled` impede o envio duplicado enquanto ela não termina.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? (
        <SpinnerIcon size={size === "sm" ? 16 : 18} />
      ) : (
        leadingIcon
      )}
      {children}
      {!loading && trailingIcon}
    </button>
  );
}

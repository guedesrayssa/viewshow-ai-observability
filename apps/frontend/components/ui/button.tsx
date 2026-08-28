/**
 * @file button.tsx
 * Botão do design system.
 *
 * Cobre as variantes desenhadas na prancha de componentes do Figma: ação
 * primária em gradiente, ação sólida em azul de marca, contorno neutro e
 * botões de texto. Toda ação da interface deve usar este componente para
 * manter altura, raio, foco e estados consistentes entre as telas.
 *
 * A aparência mora em `button-classes.ts`, que pode ser usado no servidor.
 */

"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import {
  buttonClasses,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/ui/button-classes";
import { SpinnerIcon } from "@/components/ui/icons";

export {
  buttonClasses,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/ui/button-classes";

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
      {loading ? <SpinnerIcon size={size === "sm" ? 16 : 18} /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  );
}

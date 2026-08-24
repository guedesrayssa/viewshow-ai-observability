/**
 * @file select.tsx
 * Seletor de opção única.
 *
 * Usado nas barras de filtro, onde o valor selecionado já funciona como
 * rótulo visível do campo. É um `<select>` nativo estilizado para manter o
 * comportamento de teclado e de leitor de tela do elemento original.
 */

"use client";

import type { ComponentPropsWithRef, ReactNode } from "react";

import { FIELD_SIZE_CLASSES, type FieldSize } from "@/components/ui/input";
import { ChevronDownIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

export type SelectProps = Omit<ComponentPropsWithRef<"select">, "size"> & {
  fieldSize?: FieldSize;
  /** Ícone exibido à esquerda do valor selecionado. */
  icon?: ReactNode;
};

/**
 * Seletor de opção única, compacto por padrão.
 *
 * @example
 * <Select aria-label="Período" defaultValue="30min">
 *   <option value="30min">Últimos 30 min</option>
 * </Select>
 */
export function Select({
  fieldSize = "sm",
  icon,
  className,
  children,
  ...props
}: SelectProps) {
  return (
    <div className="relative inline-flex">
      {icon ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
        >
          {icon}
        </span>
      ) : null}

      <select
        className={cn(
          "appearance-none rounded-field border border-line bg-surface text-ink",
          "font-medium transition-colors duration-150 hover:border-line-strong",
          "pr-9",
          icon ? "pl-9" : "pl-3.5",
          FIELD_SIZE_CLASSES[fieldSize],
          className,
        )}
        {...props}
      >
        {children}
      </select>

      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle"
      />
    </div>
  );
}

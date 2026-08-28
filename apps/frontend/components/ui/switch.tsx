/**
 * @file switch.tsx
 * Alternância binária.
 *
 * Usada em preferências que têm efeito imediato, sem precisar de um botão de
 * salvar — diferente de uma caixa de seleção dentro de um formulário. O papel
 * `switch` e o `aria-checked` seguem o padrão da WAI-ARIA para este controle.
 */

"use client";

import { cn } from "@/lib/cn";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Rótulo acessível, já que o texto visível fica em um elemento à parte. */
  label: string;
  disabled?: boolean;
  className?: string;
};

/**
 * Alternância ligado/desligado.
 *
 * @example
 * <Switch label="Incidentes críticos" checked={ativo} onCheckedChange={setAtivo} />
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill transition-colors duration-150",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light",
        checked ? "bg-brand-blue-light" : "bg-line-strong",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-5 w-5 rounded-pill bg-surface shadow-card transition-transform duration-150",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/**
 * @file alert.tsx
 * Aviso de bloco.
 *
 * Usado para erros de formulário e mensagens de sistema que precisam ser
 * anunciadas assim que aparecem. O papel ARIA muda com o tom: avisos críticos
 * usam `alert` (interrompem a leitura), informativos usam `status`.
 */

import type { HTMLAttributes, ReactNode } from "react";

import { AlertIcon, CheckIcon, InfoIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/** Significado do aviso. */
export type AlertTone = "critical" | "warning" | "success" | "info";

const TONE_CLASSES: Record<AlertTone, string> = {
  critical: "border-critical/30 bg-critical-soft text-critical-strong",
  warning: "border-warning/40 bg-warning-soft text-warning-strong",
  success: "border-success/30 bg-success-soft text-success-strong",
  info: "border-info/25 bg-info-soft text-brand-blue",
};

const TONE_ICONS: Record<AlertTone, ReactNode> = {
  critical: <AlertIcon size={18} />,
  warning: <AlertIcon size={18} />,
  success: <CheckIcon size={18} />,
  info: <InfoIcon size={18} />,
};

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  /** Título curto do aviso, exibido em negrito acima da mensagem. */
  title?: string;
};

/**
 * Aviso de bloco com ícone e texto.
 *
 * @example
 * <Alert tone="critical">Não foi possível entrar. Verifique as credenciais.</Alert>
 */
export function Alert({
  tone = "info",
  title,
  className,
  children,
  ...props
}: AlertProps) {
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-field border p-3.5 text-body-sm",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 shrink-0">{TONE_ICONS[tone]}</span>
      <div className="flex flex-col gap-0.5">
        {title ? <strong className="font-semibold">{title}</strong> : null}
        <span>{children}</span>
      </div>
    </div>
  );
}

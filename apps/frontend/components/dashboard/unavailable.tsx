/**
 * @file unavailable.tsx
 * O lugar de um dado que não tem fonte.
 *
 * Um painel de telemetria vale pelo que consegue afirmar, e um cartão vazio
 * afirma menos que um cartão que diz por que está vazio. Este bloco ocupa o
 * espaço do gráfico, da tabela ou do número, e diz o motivo em uma linha.
 *
 * Ele não é um erro: erro é a leitura que saiu e não voltou, e para isso
 * existe o `Alert`. Aqui a leitura nem chega a fazer sentido, porque nenhuma
 * fonte publica aquela grandeza nesta fase.
 */

import type { ReactNode } from "react";

import { InfoIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { Warning } from "@/lib/data/warnings";

export type UnavailableProps = {
  /** O que deveria estar aqui, no vocabulário da tela. */
  title: string;
  /** Por que não está. Uma frase; o detalhe técnico fica no aviso. */
  children?: ReactNode;
  /** Aviso que originou o estado, quando a leitura declarou um. */
  warning?: Warning;
  /** Altura mínima, para o bloco ocupar o mesmo espaço do que substitui. */
  minHeight?: number;
  className?: string;
};

/**
 * Espaço de um dado sem fonte, com o motivo declarado.
 *
 * @example
 * <Unavailable title="Concentração geográfica" warning={WARNINGS.semDimensaoGeografica} />
 */
export function Unavailable({
  title,
  children,
  warning,
  minHeight,
  className,
}: UnavailableProps) {
  return (
    <div
      role="status"
      style={minHeight ? { minHeight } : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line px-5 py-8 text-center",
        className,
      )}
    >
      <InfoIcon size={18} className="text-ink-subtle" aria-hidden="true" />

      <p className="text-body-sm font-medium text-ink">{title}</p>

      <p className="max-w-prose text-caption text-ink-muted">
        {children ?? warning?.message ?? "Esta medição não tem fonte nesta fase."}
      </p>
    </div>
  );
}

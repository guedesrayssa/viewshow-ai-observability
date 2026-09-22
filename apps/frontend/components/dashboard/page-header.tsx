/**
 * @file page-header.tsx
 * Cabeçalho de tela do painel.
 *
 * Todas as telas autenticadas abrem do mesmo jeito: uma linha de contexto
 * opcional, o título, o subtítulo que diz o que a tela responde e, à direita,
 * as ações específicas dela. As ações de aparência, configurações e conta não
 * aparecem aqui — moram na barra superior, em `components/shell/topbar.tsx`.
 *
 * O cabeçalho entra com o mesmo movimento em todas as telas, o que dá à
 * navegação entre elas uma continuidade que a troca seca de conteúdo não tem.
 */

import type { ReactNode } from "react";

import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/cn";

export type PageHeaderProps = {
  title: string;
  /**
   * O que a tela responde. Opcional: em telas cujo título já basta, repetir a
   * lista de seções abaixo dele só adiciona uma linha para ler.
   */
  subtitle?: string;
  /** Linha curta de contexto acima do título, como o código do incidente. */
  eyebrow?: ReactNode;
  /** Ações da tela, alinhadas à direita. */
  actions?: ReactNode;
  /** Procedência do dado, exibida abaixo do subtítulo. */
  status?: ReactNode;
  className?: string;
};

/**
 * Abertura padrão de uma tela do painel.
 *
 * @example
 * <PageHeader
 *   title="Incidentes"
 *   subtitle="Ordenados por urgência, dispositivos impactados e recência"
 *   actions={<Button variant="gradient">Exportar</Button>}
 * />
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  status,
  className,
}: PageHeaderProps) {
  return (
    <Reveal
      as="header"
      className={cn("flex flex-wrap items-start justify-between gap-4", className)}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
            {eyebrow}
          </p>
        ) : null}

        <h1 className={cn("text-h1 text-ink", eyebrow ? "mt-1" : undefined)}>{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-body-sm text-ink-brand">{subtitle}</p>
        ) : null}

        {status ? <div className="mt-3">{status}</div> : null}
      </div>

      {actions ? (
        <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div>
      ) : null}
    </Reveal>
  );
}

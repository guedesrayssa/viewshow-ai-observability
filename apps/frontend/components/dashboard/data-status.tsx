/**
 * @file data-status.tsx
 * Procedência e frescor do dado que está na tela.
 *
 * Um painel de telemetria vale pelo que consegue afirmar. Este bloco diz
 * quatro coisas em texto: de onde veio o número, o quanto do que a tela
 * desenha ficou preenchido, há quanto tempo a leitura aconteceu e se uma nova
 * está acontecendo agora.
 *
 * Procedência e completude são perguntas diferentes, e por isso dois campos: a
 * leitura pode vir da API e ainda assim estar parcial, quando parte da tela
 * não tem fonte em nenhuma das duas.
 */

"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { RefreshIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { Availability, DataSource } from "@/lib/data/client";
import type { Warning } from "@/lib/data/warnings";

/** De quanto em quanto tempo o rótulo "há X" é recalculado. */
const CLOCK_INTERVAL = 15_000;

/** Escreve a distância até agora em português corrente. */
function formatElapsed(from: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - from.getTime()) / 1000));

  if (seconds < 10) return "agora";
  if (seconds < 60) return `há ${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.round(minutes / 60);
  return `há ${hours} h`;
}

export type DataStatusProps = {
  source?: DataSource;
  availability?: Availability;
  /** O que da leitura não pôde ser preenchido, e por quê. */
  warnings?: Warning[];
  fetchedAt?: Date;
  refreshing?: boolean;
  error?: string;
  onRefresh?: () => void;
  /**
   * Mostra o selo de procedência. Desligado, sobram o horário da leitura e a
   * ação de atualizar — usado onde o cabeçalho já carrega identificação do
   * incidente e um terceiro selo passaria a competir com ela. A falha de
   * leitura e a indisponibilidade continuam sendo anunciadas de qualquer modo:
   * são as únicas informações da faixa que mudam o que a pessoa deve fazer.
   */
  showSource?: boolean;
  className?: string;
};

/** Selo de procedência, conforme a origem e a completude da leitura. */
function SourceBadge({
  source,
  availability,
}: {
  source: DataSource;
  availability?: Availability;
}) {
  if (source === "indisponivel") {
    return (
      <Badge tone="neutral" withDot role="status">
        Sem fonte de dados
      </Badge>
    );
  }

  if (source === "exemplo") {
    return (
      <Badge tone="warning" withDot role="status">
        Dados de exemplo
      </Badge>
    );
  }

  return (
    <Badge tone={availability === "partial" ? "warning" : "success"} withDot role="status">
      {availability === "partial" ? "Telemetria parcial" : "Telemetria ao vivo"}
    </Badge>
  );
}

/**
 * Selo de procedência com a ação de atualizar.
 *
 * @example
 * <DataStatus
 *   source={stats.source}
 *   availability={stats.availability}
 *   warnings={stats.warnings}
 *   fetchedAt={stats.fetchedAt}
 *   onRefresh={stats.refresh}
 * />
 */
export function DataStatus({
  source,
  availability,
  warnings = [],
  fetchedAt,
  refreshing = false,
  error,
  onRefresh,
  showSource = true,
  className,
}: DataStatusProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    return () => clearInterval(id);
  }, []);

  // A indisponibilidade aparece mesmo com o selo desligado: ela muda o que a
  // pessoa pode concluir da tela.
  const showBadge = showSource || source === "indisponivel";
  const [first, ...rest] = warnings;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-3">
        {error ? (
          <Badge tone="critical" withDot role="status">
            Leitura falhou
          </Badge>
        ) : showBadge && source ? (
          <SourceBadge source={source} availability={availability} />
        ) : null}

        {fetchedAt ? (
          <span className="text-caption text-ink-muted">
            {refreshing
              ? "atualizando…"
              : `atualizado ${formatElapsed(fetchedAt, now)}`}
          </span>
        ) : null}

        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Atualizar dados"
            title="Atualizar dados"
            className={cn(
              "focus-ring flex h-9 w-9 items-center justify-center rounded-pill border border-line bg-surface text-ink-muted",
              "transition-colors duration-200 hover:border-line-strong hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <RefreshIcon
              size={16}
              className={cn(
                "transition-transform duration-500",
                refreshing && "animate-spin",
              )}
            />
          </button>
        ) : null}
      </div>

      {/* Um aviso por vez: a faixa fica no cabeçalho, e uma lista ali empurra
          o conteúdo da tela para baixo. O restante é contado, para que a
          pessoa saiba que existe. */}
      {!error && first ? (
        <p className="max-w-prose text-caption text-ink-subtle">
          {first.message}
          {rest.length > 0
            ? ` (+${rest.length} ${rest.length === 1 ? "aviso" : "avisos"})`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * @file data-status.tsx
 * Procedência e frescor do dado que está na tela.
 *
 * Um painel de telemetria vale pelo que consegue afirmar. Este bloco diz três
 * coisas em texto: de onde veio o número, há quanto tempo ele foi lido e se
 * uma nova leitura está acontecendo agora. Sem API configurada, ele declara
 * que o conteúdo é um conjunto de exemplo em vez de deixar o número passar por
 * medição.
 */

"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { RefreshIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { DataSource } from "@/lib/data/client";

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
  fetchedAt?: Date;
  refreshing?: boolean;
  error?: string;
  onRefresh?: () => void;
  className?: string;
};

/**
 * Selo de procedência com a ação de atualizar.
 *
 * @example
 * <DataStatus source={stats.source} fetchedAt={stats.fetchedAt} onRefresh={stats.refresh} />
 */
export function DataStatus({
  source,
  fetchedAt,
  refreshing = false,
  error,
  onRefresh,
  className,
}: DataStatusProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {error ? (
        <Badge tone="critical" withDot role="status">
          Leitura falhou
        </Badge>
      ) : source === "api" ? (
        <Badge tone="success" withDot role="status">
          Telemetria ao vivo
        </Badge>
      ) : source === "exemplo" ? (
        <Badge tone="warning" withDot role="status">
          Dados de exemplo
        </Badge>
      ) : (
        <Badge tone="neutral" withDot role="status">
          Lendo telemetria
        </Badge>
      )}

      {fetchedAt ? (
        <span className="text-caption text-ink-muted">
          {refreshing ? "atualizando…" : `atualizado ${formatElapsed(fetchedAt, now)}`}
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
  );
}

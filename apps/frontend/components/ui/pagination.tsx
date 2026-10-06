/**
 * @file pagination.tsx
 * Paginação das listas do painel.
 *
 * Dois formatos, um para cada origem de dado:
 *
 * - `Pagination`: a lista inteira já está no navegador (incidentes, evidências)
 *   e é fatiada em páginas, com contagem e tamanho de página.
 * - `LoadMore`: a API entrega a lista em blocos por cursor (eventos). Não há
 *   como saltar para a página 7, então a ação é carregar o próximo bloco, e a
 *   contagem diz quanto do total já está na tela.
 *
 * Nos dois, a pessoa sempre sabe quanto está vendo do total: uma lista cortada
 * sem aviso parece completa.
 */

"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { formatInteger } from "@/lib/format";

export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

/**
 * Fatia uma lista local em páginas.
 *
 * A página volta para a primeira quando a lista muda de tamanho (novo filtro,
 * nova leitura) e deixaria a atual vazia.
 */
export function usePagedItems<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  );

  return { page: current, pageCount, pageItems };
}

/** Página e tamanho de página em estado local, para listas sem URL própria. */
export function useLocalPagination(resetKey: unknown, initialSize: PageSize = 10) {
  // A página vale para a chave em que foi escolhida: mudou o filtro, volta à
  // primeira, sem um efeito que renderize duas vezes.
  const [state, setState] = useState<{ key: unknown; page: number }>({
    key: resetKey,
    page: 1,
  });
  const [pageSize, setPageSize] = useState<PageSize>(initialSize);
  const page = Object.is(state.key, resetKey) ? state.page : 1;

  return {
    page,
    pageSize,
    setPage: (next: number) => setState({ key: resetKey, page: next }),
    setPageSize: (size: PageSize) => {
      setPageSize(size);
      setState({ key: resetKey, page: 1 });
    },
  };
}

function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return "Nenhum item";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return `Exibindo ${formatInteger(first)}–${formatInteger(last)} de ${formatInteger(total)}`;
}

export type PaginationProps = {
  page: number;
  pageCount: number;
  pageSize: PageSize;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: PageSize) => void;
  /** O que está sendo paginado, para o leitor de tela ("incidentes"). */
  itemLabel: string;
  className?: string;
};

export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  itemLabel,
  className,
}: PaginationProps) {
  if (total === 0) return null;

  return (
    <nav
      aria-label={`Paginação de ${itemLabel}`}
      className={cn(
        "mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4",
        className,
      )}
    >
      <p className="text-caption text-ink-muted tabular-nums" aria-live="polite">
        {rangeLabel(page, pageSize, total)}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <Select
            aria-label={`Itens por página em ${itemLabel}`}
            fieldSize="sm"
            value={String(pageSize)}
            onValueChange={(value) => {
              const size = Number(value);
              if (isPageSize(size)) onPageSizeChange(size);
            }}
            options={PAGE_SIZE_OPTIONS.map((size) => ({
              value: String(size),
              label: `${size} por página`,
            }))}
          />
        ) : null}

        {pageCount > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="quiet"
              size="sm"
              aria-label="Página anterior"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeftIcon size={16} />
            </Button>
            <span className="min-w-[5.5rem] text-center text-caption text-ink-muted tabular-nums">
              Página {page} de {pageCount}
            </span>
            <Button
              variant="quiet"
              size="sm"
              aria-label="Próxima página"
              disabled={page >= pageCount}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRightIcon size={16} />
            </Button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

export type LoadMoreProps = {
  /** Itens já na tela. */
  shown: number;
  /** Total informado pela origem, quando ela informa. */
  total?: number | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  itemLabel: string;
  className?: string;
};

export function LoadMore({
  shown,
  total,
  hasMore,
  loading,
  onLoadMore,
  itemLabel,
  className,
}: LoadMoreProps) {
  if (shown === 0) return null;

  const knownTotal = typeof total === "number" && total >= shown ? total : null;

  return (
    <div
      className={cn(
        "mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4",
        className,
      )}
    >
      <p className="text-caption text-ink-muted tabular-nums" aria-live="polite">
        {knownTotal === null
          ? `Exibindo ${formatInteger(shown)} ${itemLabel}${hasMore ? " · há mais na origem" : ""}`
          : `Exibindo ${formatInteger(shown)} de ${formatInteger(knownTotal)} ${itemLabel}`}
      </p>

      {hasMore ? (
        <Button variant="outline" size="sm" loading={loading} disabled={loading} onClick={onLoadMore}>
          {loading ? "Carregando…" : "Carregar mais"}
        </Button>
      ) : null}
    </div>
  );
}

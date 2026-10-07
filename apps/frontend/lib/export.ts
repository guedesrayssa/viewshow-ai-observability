/**
 * @file export.ts
 * Exportação das listas do painel em CSV.
 *
 * O arquivo é montado no navegador com o que está carregado na tela, no
 * mesmo recorte de filtros. Usa ponto e vírgula e BOM porque é o formato que
 * o Excel em português abre sem pedir importação.
 */

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((column) => escapeCell(column.header)).join(";");
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(column.value(row))).join(";"),
  );
  return [header, ...body].join("\r\n");
}

/** Nome de arquivo com data e hora, para exportações seguidas não se sobrescreverem. */
export function exportFileName(prefix: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${prefix}-${stamp}.csv`;
}

export function downloadCsv<T>(
  fileName: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): void {
  const blob = new Blob([`﻿${toCsv(rows, columns)}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

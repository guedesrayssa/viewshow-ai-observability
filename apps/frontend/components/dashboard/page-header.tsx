/**
 * @file page-header.tsx
 * Cabeçalho de tela do painel: título, subtítulo e a ação primária da área.
 *
 * As ações fixas de tema e configurações já vêm da moldura em
 * `app/(painel)/layout.tsx` — este cabeçalho cuida só do que é específico da
 * tela.
 */

import { Button } from "@/components/ui/button";
import { ExportIcon } from "@/components/ui/icons";

type PageHeaderProps = {
  title: string;
  subtitle: string;
};

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pr-28">
      <div>
        <h1 className="text-h1 text-ink">{title}</h1>
        <p className="mt-1 text-body-sm text-brand-blue">{subtitle}</p>
      </div>
      <Button variant="gradient" leadingIcon={<ExportIcon size={18} />}>
        Exportar
      </Button>
    </div>
  );
}

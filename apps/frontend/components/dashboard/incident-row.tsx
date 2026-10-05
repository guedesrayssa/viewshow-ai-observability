/**
 * @file incident-row.tsx
 * Linha da lista curta de incidentes da Visão Geral.
 *
 * Com `href`, a linha inteira abre o diagnóstico do incidente: antes ela não
 * era clicável e o único caminho era "Ver todos" e procurar de novo.
 */

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ChevronRightIcon } from "@/components/ui/icons";
import type { IncidentData } from "@/lib/dashboard-data";

export function IncidentRow({
  href,
  title,
  sessions,
  timeAgo,
  status,
  statusLabel,
}: IncidentData) {
  const content = (
    <>
      <div className="min-w-0">
        <p className="truncate text-body-sm font-semibold text-ink">{title}</p>
        <p className="text-caption text-ink-muted">
          {sessions} · {timeAgo}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <Badge tone={status} withDot>
          {statusLabel}
        </Badge>
        {href ? <ChevronRightIcon size={16} className="text-ink-subtle" /> : null}
      </span>
    </>
  );

  if (!href) {
    return <div className="flex items-center justify-between gap-3 py-3">{content}</div>;
  }

  return (
    <Link
      href={href}
      className="focus-ring -mx-2 flex items-center justify-between gap-3 rounded-field px-2 py-3 transition-colors duration-200 hover:bg-surface-muted"
    >
      {content}
    </Link>
  );
}

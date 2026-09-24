/**
 * @file events-table.tsx
 * Tabela "Eventos correlacionados", com detalhe expansível por linha.
 *
 * Cobre a US-ENG-02: ao expandir uma linha, mostra o dado normalizado
 * (métrica, timestamp, tags e valor) e a ligação com a fonte original,
 * sinalizando quando não há correspondência bruta direta. Apenas uma linha
 * fica expandida por vez, no mesmo padrão de acordeão das evidências por
 * fonte da tela de Evidências.
 */

"use client";

import { Fragment } from "react";

import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

import {
  CATEGORY_LABELS,
  CATEGORY_TEXT_CLASSES,
  type CorrelatedEvent,
  type EventCategory,
} from "@/app/(painel)/eventos/events-data";

const ROW_ACCENT_CLASSES: Record<EventCategory, string> = {
  signal_observation: "border-l-brand-orange bg-warning/5",
  live_event: "border-l-brand-blue-light bg-info/5",
  live_event_context: "border-l-brand-navy bg-info/5",
};

export type EventsTableProps = {
  events: CorrelatedEvent[];
  expandedId: string | null;
  onToggle: (id: string) => void;
};

export function EventsTable({
  events,
  expandedId,
  onToggle,
}: EventsTableProps) {
  if (events.length === 0) {
    return (
      <p className="mt-8 text-center text-body-sm text-ink-muted">
        Nenhum evento encontrado para os filtros aplicados.
      </p>
    );
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full min-w-[56rem] border-collapse">
        <thead>
          <tr className="text-left text-caption font-medium uppercase text-ink-brand">
            <th scope="col" className="pb-3 pr-4">
              Horário
            </th>
            <th scope="col" className="pb-3 pr-4">
              Tipo
            </th>
            <th scope="col" className="pb-3 pr-4">
              Fonte
            </th>
            <th scope="col" className="pb-3 pr-4">
              Entidade
            </th>
            <th scope="col" className="pb-3 pr-4">
              Resumo
            </th>
            <th scope="col" className="pb-3 pr-4">
              Qualidade
            </th>
            <th scope="col" className="pb-3">
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => {
            const expanded = event.id === expandedId;
            const detailId = `evento-detalhe-${event.id}`;

            return (
              <Fragment key={event.id}>
                <Reveal
                  as="tr"
                  index={index}
                  variant="rise-sm"
                  className={cn(
                    "border-t border-line-subtle align-top",
                    "border-l-4 transition-colors duration-200",
                    expanded
                      ? ROW_ACCENT_CLASSES[event.category]
                      : "border-l-transparent hover:bg-surface-muted",
                  )}
                >
                  <td className="py-4 pr-4 pl-3 text-body-sm text-ink-muted whitespace-nowrap">
                    {event.time}
                  </td>
                  <td
                    className={cn(
                      "py-4 pr-4 text-body-sm font-semibold whitespace-nowrap",
                      CATEGORY_TEXT_CLASSES[event.category],
                    )}
                  >
                    {CATEGORY_LABELS[event.category]}
                  </td>
                  <td className="py-4 pr-4 text-body-sm text-ink-muted">
                    {event.source}
                  </td>
                  <td className="py-4 pr-4 text-body-sm text-ink-muted">
                    {event.entity}
                  </td>
                  <td className="py-4 pr-4 text-body-sm font-medium text-ink">
                    {event.summary}
                  </td>
                  <td className="py-4 pr-4">
                    <Badge tone={event.quality.tone}>
                      {event.quality.label}
                    </Badge>
                  </td>
                  <td className="py-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      onClick={() => onToggle(event.id)}
                    >
                      {expanded ? "Recolher" : "Expandir"}
                    </Button>
                  </td>
                </Reveal>

                {expanded ? (
                  <tr
                    id={detailId}
                    className={cn(
                      "animate-rise-sm border-l-4",
                      ROW_ACCENT_CLASSES[event.category],
                    )}
                  >
                    <td colSpan={7} className="bg-surface-muted px-4 py-5">
                      <div className="grid gap-6 sm:grid-cols-2">
                        <div>
                          <p className="text-label font-medium text-ink">
                            Dado normalizado
                          </p>
                          <dl className="mt-2 flex flex-col gap-1.5 text-body-sm">
                            <div className="flex gap-2">
                              <dt className="text-ink-muted">Métrica</dt>
                              <dd className="font-medium text-ink">
                                {event.detail.metric}
                              </dd>
                            </div>
                            <div className="flex gap-2">
                              <dt className="text-ink-muted">Timestamp</dt>
                              <dd className="font-medium text-ink">
                                {event.detail.timestamp}
                              </dd>
                            </div>
                            <div className="flex gap-2">
                              <dt className="text-ink-muted">Valor</dt>
                              <dd className="font-medium text-ink">
                                {event.detail.value}
                              </dd>
                            </div>
                            <div className="flex gap-2">
                              <dt className="text-ink-muted">
                                Registro de origem
                              </dt>
                              <dd className="break-all font-medium text-ink">
                                {event.detail.sourceRecordId}
                              </dd>
                            </div>
                          </dl>

                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {event.detail.tags.map((tag) => (
                              <Badge key={tag} tone="neutral">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-label font-medium text-ink">
                            Origem · {event.source} / {event.entity}
                          </p>

                          <p className="mt-2 break-all text-caption text-ink-muted">
                            {event.detail.canonicalLocator}
                          </p>
                          {!event.detail.rawAvailable ? (
                            <Alert tone="warning" className="mt-2">
                              Dado bruto não disponível:{" "}
                              {event.detail.rawReason}.
                            </Alert>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

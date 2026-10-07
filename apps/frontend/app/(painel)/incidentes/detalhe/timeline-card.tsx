/**
 * @file timeline-card.tsx
 * Linha do tempo de um incidente: marcos correlacionados no mesmo recorte e
 * mudanças que podem ter impactado.
 */

"use client";

import {
  TIMELINE_DOT_CLASSES,
  type EvidenceData,
} from "@/app/(painel)/incidentes/detalhe/evidence-data";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

export function TimelineCard({ data }: { data?: EvidenceData }) {
  return (
    <Card padding="lg">
      <CardTitle>Linha do tempo e mudanças que podem ter impactado</CardTitle>
      <CardDescription className="mt-1">
        Marcos correlacionados no mesmo recorte · horário de Brasília
      </CardDescription>

      {/* Três estados que se excluem: carregando, sem marcos e com marcos.
          Antes, sem marcos, a tela mostrava o aviso e o esqueleto ao mesmo
          tempo, como se ainda fosse carregar algo. */}
      {!data ? (
        <Skeleton className="mt-8 h-28 w-full" />
      ) : data.timeline.length === 0 ? (
        <Unavailable title="Sem linha do tempo de mudanças" className="mt-6">
          Nenhuma das origens atuais registra deploys ou mudanças correlacionadas
          a este incidente. A linha do tempo volta quando o serviço de ingestão
          publicar esses marcos.
        </Unavailable>
      ) : (
        <>
          <div className="mt-8 overflow-x-auto">
            <ol className="flex min-w-max gap-2">
              {data.timeline.map((mark, index) => (
                <Reveal
                  as="li"
                  key={`${mark.timestamp ?? mark.time}-${index}`}
                  index={index}
                  variant="rise-sm"
                  className="flex w-36 flex-col items-center gap-2 text-center"
                >
                  <span className="text-caption font-semibold text-ink">{mark.time}</span>
                  <span className="relative flex w-full items-center justify-center py-1">
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 top-1/2 h-px bg-line"
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "relative z-10 h-3 w-3 rounded-pill border-2 border-surface shadow-card",
                        TIMELINE_DOT_CLASSES[mark.tone],
                      )}
                    />
                  </span>
                  <span className="text-body-sm font-medium text-ink">{mark.label}</span>
                  <span className="text-caption text-ink-brand">{mark.source}</span>
                </Reveal>
              ))}
            </ol>
          </div>

          {data.changes.length > 0 ? (
            <div className="mt-6 flex flex-wrap gap-2">
              {data.changes.map((item, index) => (
                <Reveal key={`${item.cause}-${index}`} index={index} variant="scale">
                  <Badge tone={item.tone}>
                    {item.label}: {item.cause} · {item.percentage}%
                  </Badge>
                </Reveal>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * @file incident-detail-header.tsx
 * Cabeçalho comum às abas do detalhe de um incidente.
 *
 * Diz de qual incidente se trata (código legível, título, prioridade, estado
 * e há quanto tempo começou), dá o caminho de volta à lista e troca entre o
 * diagnóstico, os eventos correlacionados e a linha do tempo sem perder o incidente — antes,
 * cada tela era um item da navegação e o contexto se perdia no clique.
 */

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { IncidentSummary } from "@/app/(painel)/incidentes/detalhe/evidence-data";
import { Breadcrumb } from "@/components/navigation/breadcrumb";
import { TabLinks } from "@/components/navigation/tab-links";
import { Reveal } from "@/components/motion/reveal";
import { Badge } from "@/components/ui/badge";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatElapsed } from "@/lib/format";
import {
  incidentCode,
  incidentHeadline,
  incidentStatusLabel,
  incidentStatusTone,
  priorityLabel,
  priorityTone,
} from "@/lib/incidents/labels";
import {
  incidentDiagnosisHref,
  incidentEventsHref,
  incidentTimelineHref,
  ROUTES,
} from "@/lib/routes";

/** Abas do detalhe. O rótulo também fecha a trilha de navegação. */
export type IncidentDetailSection = "diagnosis" | "events" | "timeline";

const SECTION_LABELS: Record<IncidentDetailSection, string> = {
  diagnosis: "Diagnóstico",
  events: "Eventos correlacionados",
  timeline: "Linha do tempo",
};

export type IncidentDetailHeaderProps = {
  incidentId: string;
  /** Aba em que a pessoa está; fecha a trilha "Incidentes › código › aba". */
  section: IncidentDetailSection;
  /** Resumo do incidente; ausente enquanto a leitura não chega. */
  incident?: IncidentSummary;
  /** Procedência do dado da aba atual. */
  status?: ReactNode;
  actions?: ReactNode;
};

export function IncidentDetailHeader({
  incidentId,
  section,
  incident,
  status,
  actions,
}: IncidentDetailHeaderProps) {
  const code = incident ? incidentCode(incident) : incidentId;
  const headline = incident ? incidentHeadline(incident) : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumb
          items={[
            { label: "Incidentes", href: ROUTES.incidents },
            { label: code, href: incidentDiagnosisHref(incidentId) },
            { label: SECTION_LABELS[section] },
          ]}
        />
        {/* O caminho de volta explícito: a trilha também leva à lista, mas um
            alvo maior e com verbo é o que se procura depois de investigar. */}
        <Link
          href={ROUTES.incidents}
          className="focus-ring inline-flex items-center gap-1 rounded-field text-caption font-semibold text-ink-brand hover:underline"
        >
          <ChevronLeftIcon size={14} />
          Voltar para Incidentes
        </Link>
      </div>

      <Reveal
        as="header"
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div className="min-w-0">
          {incident ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={priorityTone(incident.severity)}>
                  {priorityLabel(incident.severity)}
                </Badge>
                <Badge tone={incidentStatusTone(incident.investigationStatus)}>
                  {incidentStatusLabel(incident.investigationStatus)}
                </Badge>
                <span className="text-caption text-ink-muted">
                  Início {formatDateTime(incident.startedAt)} · há{" "}
                  {formatElapsed(incident.startedMinutesAgo)}
                </span>
              </div>
              <h1 className="mt-2 text-h1 text-ink">{code}</h1>
              {headline ? (
                <p className="mt-1 text-body-sm text-ink-brand">{headline}</p>
              ) : null}
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-48 rounded-pill" />
              <Skeleton className="mt-3 h-8 w-64" />
            </>
          )}

          {status ? <div className="mt-3">{status}</div> : null}
        </div>

        {actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div>
        ) : null}
      </Reveal>

      <TabLinks
        label={`Seções do incidente ${code}`}
        tabs={[
          {
            label: SECTION_LABELS.diagnosis,
            path: ROUTES.incidentDetail,
            href: incidentDiagnosisHref(incidentId),
          },
          {
            label: SECTION_LABELS.events,
            path: ROUTES.incidentEvents,
            href: incidentEventsHref(incidentId),
          },
          {
            label: SECTION_LABELS.timeline,
            path: ROUTES.incidentTimeline,
            href: incidentTimelineHref(incidentId),
          },
        ]}
      />
    </div>
  );
}

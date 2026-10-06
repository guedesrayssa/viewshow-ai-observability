/**
 * @file timeline-view.tsx
 * Aba Linha do tempo do detalhe de um incidente.
 *
 * Os marcos e as mudanças correlacionadas chegam na mesma leitura do
 * diagnóstico; a aba própria existe para que a linha do tempo tenha lugar e
 * endereço, em vez de ficar no fim de uma página longa.
 */

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { fetchEvidence } from "@/app/(painel)/incidentes/detalhe/evidence-resource";
import { IncidentDetailHeader } from "@/app/(painel)/incidentes/detalhe/incident-detail-header";
import { TimelineCard } from "@/app/(painel)/incidentes/detalhe/timeline-card";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";
import { resourceFailed, resourceFailureMessage } from "@/lib/data/resource-state";
import { ROUTES } from "@/lib/routes";

export function TimelineView() {
  const incidentId = useSearchParams().get("incidente");

  if (!incidentId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Linha do tempo do incidente"
          subtitle="Marcos e mudanças correlacionadas a um incidente"
        />
        <Unavailable title="Escolha um incidente para investigar" minHeight={280}>
          A linha do tempo é sempre de um incidente específico. Abra um
          incidente na lista para ver os marcos correlacionados.
        </Unavailable>
        <Link
          href={ROUTES.incidents}
          className={cn(buttonClasses({ variant: "gradient" }), "self-center")}
        >
          Ir para Incidentes
        </Link>
      </div>
    );
  }

  return <IncidentTimeline key={incidentId} incidentId={incidentId} />;
}

function IncidentTimeline({ incidentId }: { incidentId: string }) {
  const evidence = useResource(() => fetchEvidence(incidentId), [incidentId]);
  const failed = resourceFailed(evidence);

  return (
    <div className="flex flex-col gap-6">
      <IncidentDetailHeader
        incidentId={incidentId}
        section="timeline"
        incident={evidence.data?.incident}
        status={
          <DataStatus
            showSource={false}
            source={evidence.source}
            availability={evidence.availability}
            warnings={evidence.warnings}
            fetchedAt={evidence.fetchedAt}
            refreshing={evidence.refreshing}
            error={evidence.error}
            onRefresh={evidence.refresh}
          />
        }
      />

      {failed ? (
        <>
          <Alert tone="critical" title="Não foi possível ler a linha do tempo">
            {resourceFailureMessage(evidence, "O diagnóstico deste incidente não respondeu.")}{" "}
            Tente atualizar em alguns instantes.
          </Alert>
          <Unavailable title="Linha do tempo indisponível" minHeight={220}>
            Sem a leitura do diagnóstico, nenhum marco é exibido para não
            afirmar uma sequência que não foi medida.
          </Unavailable>
        </>
      ) : (
        <Reveal>
          <TimelineCard data={evidence.data} />
        </Reveal>
      )}
    </div>
  );
}

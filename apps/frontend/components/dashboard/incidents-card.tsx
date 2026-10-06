/**
 * @file incidents-card.tsx
 * Lista curta de incidentes da Visão Geral.
 *
 * Mostra o que exige atenção agora e leva à tela de Incidentes, onde a lista
 * completa pode ser filtrada e ordenada. As linhas entram em cascata, na ordem
 * de prioridade — a leitura de cima para baixo é a mesma da urgência.
 */

import Link from "next/link";

import { Reveal } from "@/components/motion/reveal";
import { IncidentRow } from "@/components/dashboard/incident-row";
import { buttonClasses } from "@/components/ui/button-classes";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { IncidentData } from "@/lib/dashboard-data";
import { incidentsHref } from "@/lib/routes";

export function IncidentsCard({ incidents }: { incidents: IncidentData[] }) {
  return (
    <Card className="flex w-full flex-col lg:w-88">
      <CardTitle>Incidentes</CardTitle>
      <CardDescription>Priorizados por impacto</CardDescription>

      <div className="mt-2 divide-y divide-line">
        {incidents.map((incident, index) => (
          <Reveal key={incident.id} index={index} variant="rise-sm">
            <IncidentRow {...incident} />
          </Reveal>
        ))}
      </div>

      {/* A lista de Incidentes abre em todo o período, como esta: o "Ver
          todos" e o item da navegação levam à mesma lista. */}
      <Link
        href={incidentsHref()}
        className={buttonClasses({
          variant: "gradient",
          fullWidth: true,
          className: "mt-6",
        })}
      >
        Ver todos
      </Link>
    </Card>
  );
}

/** Espaço reservado da lista, enquanto a leitura não termina. */
export function IncidentsCardSkeleton() {
  return (
    <Card className="flex w-full flex-col lg:w-88">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-2 h-3 w-36" />

      <div className="mt-4 flex flex-col gap-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="mt-1.5 h-3 w-40" />
            </div>
            <Skeleton className="h-6 w-16 rounded-pill" />
          </div>
        ))}
      </div>

      <Skeleton className="mt-6 h-11 w-full" />
    </Card>
  );
}

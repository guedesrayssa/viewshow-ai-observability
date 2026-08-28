/**
 * @file service-health-card.tsx
 * Cartão "Saúde dos serviços".
 *
 * É a leitura real da tela de Monitoramento: os serviços e as dependências
 * derivados dos traces que chegam com eventos e erros. Cada linha da tabela é
 * um serviço observado, com chamadas, erros e latência; abaixo, as chamadas
 * entre serviços, com a taxa de erro de cada aresta — é onde se vê qual
 * dependência está derrubando quem.
 */

"use client";

import { DataStatus } from "@/components/dashboard/data-status";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatInteger, formatPercent } from "@/lib/format";
import type { UseResourceResult } from "@/hooks/use-resource";
import type { ServiceTopology } from "@/app/(painel)/monitoramento/telemetry-resource";

/** Como cada estado de serviço aparece em texto e cor. */
const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  healthy: { label: "Saudável", tone: "success" },
  degraded: { label: "Degradado", tone: "warning" },
  critical: { label: "Crítico", tone: "critical" },
};

export function ServiceHealthCard({
  topology,
}: {
  topology: UseResourceResult<ServiceTopology>;
}) {
  const data = topology.data;

  return (
    <Card padding="lg" className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Saúde dos serviços</CardTitle>
          <CardDescription className="mt-1">
            Derivada dos traces reportados com eventos e erros
          </CardDescription>
        </div>

        <DataStatus
          source={topology.source}
          availability={topology.availability}
          fetchedAt={topology.fetchedAt}
          refreshing={topology.refreshing}
        />
      </div>

      {topology.status === "loading" ? (
        <div className="mt-5 flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : !data || data.services.length === 0 ? (
        <Unavailable title="Nenhum trace na janela" className="mt-5 flex-1">
          A saúde dos serviços é derivada dos traces enviados pela telemetria.
          Sem eventos com spans na janela, não há o que medir.
        </Unavailable>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] border-separate border-spacing-y-1.5">
              <thead className="text-left text-micro uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th scope="col" className="px-3 pb-1">
                    Serviço
                  </th>
                  <th scope="col" className="px-3 pb-1">
                    Estado
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right">
                    Chamadas
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right">
                    Erros
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right">
                    Taxa
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right">
                    p95
                  </th>
                </tr>
              </thead>
              <tbody className="text-body-sm">
                {data.services.map((service, index) => {
                  const meta = STATUS_META[service.status];

                  return (
                    <Reveal
                      as="tr"
                      key={service.service}
                      index={index}
                      variant="rise-sm"
                      className="rounded-field bg-surface-muted"
                    >
                      <th
                        scope="row"
                        className="rounded-l-field px-3 py-2.5 text-left font-medium text-ink"
                      >
                        {service.service}
                      </th>
                      <td className="px-3 py-2.5">
                        <Badge tone={meta.tone} withDot>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                        {formatInteger(service.calls)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                        {formatInteger(service.errors)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 text-right font-medium tabular-nums",
                          service.errorRate > 0.2
                            ? "text-critical-strong"
                            : service.errorRate > 0.05
                              ? "text-warning-strong"
                              : "text-ink",
                        )}
                      >
                        {formatPercent(service.errorRate * 100, 1)}
                      </td>
                      <td className="rounded-r-field px-3 py-2.5 text-right tabular-nums text-ink-muted">
                        {service.latencyP95 === null
                          ? "—"
                          : `${formatInteger(Math.round(service.latencyP95))} ms`}
                      </td>
                    </Reveal>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.dependencies.length > 0 ? (
            <>
              <p className="mt-4 text-caption font-medium text-ink">
                Chamadas entre serviços
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {data.dependencies.map((dependency, index) => (
                  <Reveal
                    as="li"
                    key={`${dependency.source}-${dependency.target}`}
                    index={index}
                    variant="scale"
                  >
                    <Badge
                      tone={
                        dependency.errorRate > 0.2
                          ? "critical"
                          : dependency.errorRate > 0.05
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {dependency.source} → {dependency.target} ·{" "}
                      {formatPercent(dependency.errorRate * 100, 1)}
                    </Badge>
                  </Reveal>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * @file sources-table.tsx
 * Tabela "Fontes e qualidade da telemetria".
 *
 * Lista a última atualização, a cobertura e o estado de cada fonte, como
 * descrito na seção 5.6 do entendimento de UX. O estado aparece sempre em
 * texto, pelo selo do design system, e a linha da fonte atrasada recebe
 * fundo próprio apenas como reforço: nenhuma informação depende da cor.
 */

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

import {
  formatSeconds,
  type SourceState,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";

const STATE_META: Record<
  SourceState,
  { label: string; tone: BadgeTone; rowClass: string }
> = {
  estavel: { label: "Estável", tone: "success", rowClass: "bg-surface-muted" },
  /* Tinta mais fraca que a do selo, para que o selo continue destacado. */
  atrasado: { label: "Atrasado", tone: "critical", rowClass: "bg-critical/5" },
  parcial: { label: "Parcial", tone: "warning", rowClass: "bg-surface-muted" },
};

export function SourcesTable({ sources }: { sources: TelemetrySource[] }) {
  return (
    <section aria-labelledby="fontes-telemetria">
      <h3 id="fontes-telemetria" className="text-title text-ink">
        Fontes e qualidade da telemetria
      </h3>

      {sources.length === 0 ? (
        <p className="mt-6 text-center text-body-sm text-ink-muted">
          Nenhuma fonte corresponde aos filtros aplicados.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-separate border-spacing-y-2">
            <thead>
              <tr className="text-left text-caption font-medium uppercase text-brand-blue">
                <th scope="col" className="px-4 pb-1">
                  Fonte
                </th>
                <th scope="col" className="px-4 pb-1">
                  Atualização
                </th>
                <th scope="col" className="px-4 pb-1">
                  Cobertura
                </th>
                <th scope="col" className="px-4 pb-1">
                  Estado
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const meta = STATE_META[source.state];

                return (
                  <tr key={source.id} className={cn("text-body-sm", meta.rowClass)}>
                    <th
                      scope="row"
                      className="rounded-l-field px-4 py-3 text-left font-medium text-ink"
                    >
                      {source.name}
                    </th>
                    <td className="px-4 py-3 text-ink-muted">
                      {formatSeconds(source.updatedSecondsAgo)}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{source.coverage}%</td>
                    <td className="rounded-r-field px-4 py-3">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-caption text-brand-blue">
        Falhas e atrasos reduzem a confiança do diagnóstico e permanecem visíveis nas
        evidências.
      </p>
    </section>
  );
}

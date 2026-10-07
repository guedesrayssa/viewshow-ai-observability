/**
 * @file incidents-view.tsx
 * Busca, filtros, lista paginada e gráfico dos incidentes que exigem atenção.
 *
 * Cobre a US-N1-01 (visualizar incidentes priorizados) e a US-N1-04
 * (segmentar o incidente). Cada linha leva ao detalhe do incidente, onde
 * ficam o diagnóstico e os eventos correlacionados.
 *
 * Os filtros oferecidos são os que a API de incidentes aceita (período,
 * prioridade e estado). Dispositivo, região e versão só aparecem quando a
 * origem os declarar em `capabilities`: antes eles eram oferecidos, a API
 * respondia erro e a tela mostrava "nenhum incidente".
 *
 * Filtros, ordenação e página moram na URL, para que recarregar, voltar do
 * detalhe ou compartilhar o link reproduza a mesma lista.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { IncidentsChart } from "@/app/(painel)/incidentes/incidents-chart";
import {
  DEFAULT_PERIOD,
  DEVICE_COUNT_CLASSES,
  PERIOD_KEYS,
  PERIOD_LABELS,
  PRIORITY_FILTERS,
  SORT_KEYS,
  SORT_LABELS,
  STATUS_FILTERS,
  URGENCY_META,
  sortIncidents,
  type Incident,
  type PeriodKey,
  type SortKey,
} from "@/app/(painel)/incidentes/incidents-data";
import {
  fetchAffectedDevices,
  fetchIncidents,
} from "@/app/(painel)/incidentes/incidents-resource";
import { IncidentsSectionTabs } from "@/components/incidents/incidents-section-tabs";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ExportIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PAGE_SIZE_OPTIONS,
  isPageSize,
  usePagedItems,
  type PageSize,
} from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useQueryParams } from "@/hooks/use-query-params";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";
import { resourceFailed, resourceFailureMessage } from "@/lib/data/resource-state";
import { downloadCsv, exportFileName } from "@/lib/export";
import { formatInteger } from "@/lib/format";
import {
  INCIDENT_STATUS_META,
  incidentStatusLabel,
  incidentStatusTone,
} from "@/lib/incidents/labels";
import { incidentDiagnosisHref, incidentEventsHref } from "@/lib/routes";

/** Releitura automática da lista, no ritmo de acompanhamento de plantão. */
const REFRESH_MS = 45_000;

export function IncidentsView() {
  const { searchParams, read, update } = useQueryParams();

  const period = read<PeriodKey>("periodo", DEFAULT_PERIOD, PERIOD_KEYS);
  const requestedPriority = read<string>("prioridade", "all", ["all", ...PRIORITY_FILTERS]);
  const requestedStatus = read<string>("estado", "all", ["all", ...STATUS_FILTERS]);

  // A API diz em `capabilities.filtering` quais dimensões ela recorta. Até a
  // primeira resposta, os filtros previstos aparecem; depois, um filtro que
  // ela não aceita some da tela e não vai na leitura, em vez de voltar 422 e
  // parecer uma lista vazia.
  const [supportedDimensions, setSupportedDimensions] = useState<string[] | null>(null);
  const supports = (dimension: string) =>
    supportedDimensions === null || supportedDimensions.includes(dimension);
  const priority = supports("priority") ? requestedPriority : "all";
  const status = supports("status") ? requestedStatus : "all";
  const sort = read<SortKey>("ordem", "urgency", SORT_KEYS);
  const page = Math.max(1, Number(searchParams.get("pagina")) || 1);
  const sizeParam = Number(searchParams.get("itens"));
  const pageSize: PageSize = isPageSize(sizeParam) ? sizeParam : PAGE_SIZE_OPTIONS[0];

  // A busca por código ou título é local: acompanha a digitação sem ir à API
  // a cada tecla (a API de incidentes não aceita busca textual).
  const [search, setSearch] = useState(searchParams.get("busca") ?? "");
  // A URL acompanha a busca depois de uma pausa na digitação, e não a cada
  // tecla.
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  useEffect(() => {
    if ((searchParams.get("busca") ?? "") !== debouncedSearch) {
      update({ busca: debouncedSearch || null, pagina: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const incidents = useResource(
    (revision) => fetchIncidents({ period, priority, status, sort }, revision),
    [period, priority, status, sort],
    { refreshMs: REFRESH_MS },
  );

  // O gráfico segue o período da lista. Antes ele tinha o próprio seletor e
  // abria em "última hora" ao lado de uma lista de 24 horas.
  const chart = useResource(
    (revision) => fetchAffectedDevices(period, revision),
    [period],
    { refreshMs: REFRESH_MS },
  );

  const failed = resourceFailed(incidents);
  const list = incidents.data;

  // Guarda as dimensões da última resposta. É um ajuste durante a
  // renderização, e não um efeito: a comparação impede que ele se repita.
  const listedDimensions = list?.supportedDimensions;
  if (
    listedDimensions &&
    !(
      supportedDimensions !== null &&
      supportedDimensions.length === listedDimensions.length &&
      supportedDimensions.every((item) => listedDimensions.includes(item))
    )
  ) {
    setSupportedDimensions(listedDimensions);
  }

  const visibleIncidents = useMemo(() => {
    const query = search.trim().toLowerCase();
    const items = (list?.items ?? []).filter(
      (incident) =>
        query === "" ||
        incident.code.toLowerCase().includes(query) ||
        incident.title.toLowerCase().includes(query),
    );
    return sortIncidents(items, sort);
  }, [list, search, sort]);

  const paged = usePagedItems(visibleIncidents, page, pageSize);

  const hasActiveFilters =
    search !== "" ||
    period !== DEFAULT_PERIOD ||
    priority !== "all" ||
    status !== "all";

  function setFilter(patch: Record<string, string | null>) {
    // Todo filtro novo volta para a primeira página.
    update({ ...patch, pagina: null });
  }


  function clearFilters() {
    setSearch("");
    update({
      busca: null,
      periodo: null,
      prioridade: null,
      estado: null,
      pagina: null,
    });
  }

  function exportIncidents() {
    downloadCsv(exportFileName("incidentes"), visibleIncidents, [
      { header: "Código", value: (incident) => incident.code },
      { header: "Título", value: (incident) => incident.title },
      { header: "Prioridade", value: (incident) => incident.urgency },
      { header: "Estado", value: (incident) => incidentStatusLabel(incident.status) },
      { header: "Dispositivos", value: (incident) => incident.devices },
      { header: "Início", value: (incident) => incident.startedAtIso },
      { header: "Componente", value: (incident) => incident.component },
      { header: "Recorte", value: (incident) => incident.segment },
      { header: "ID", value: (incident) => incident.id },
    ]);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidentes"
        subtitle="Ordenados por urgência, dispositivos impactados e recência"
        status={
          <DataStatus
            source={incidents.source}
            availability={incidents.availability}
            warnings={incidents.warnings}
            fetchedAt={incidents.fetchedAt}
            refreshing={incidents.refreshing}
            error={incidents.error}
            onRefresh={incidents.refresh}
          />
        }
        actions={
          <Button
            variant="gradient"
            leadingIcon={<ExportIcon size={18} />}
            disabled={visibleIncidents.length === 0}
            onClick={exportIncidents}
            title="Exporta em CSV os incidentes do recorte atual"
          >
            Exportar
          </Button>
        }
      />

      <IncidentsSectionTabs />

      {failed ? (
        <Alert tone="critical" title="Não foi possível ler os incidentes">
          {resourceFailureMessage(incidents, "A origem de incidentes não respondeu.")}{" "}
          Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <Reveal delay={80}>
        <Card padding="md">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 basis-64">
              <SearchIcon
                size={18}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
              />
              <Input
                type="search"
                fieldSize="sm"
                placeholder="Buscar por código ou título"
                aria-label="Buscar incidente"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-10"
              />
            </div>

            <Select
              aria-label="Filtrar por período"
              value={period}
              onValueChange={(value) =>
                setFilter({ periodo: value === DEFAULT_PERIOD ? null : value })
              }
              options={PERIOD_KEYS.map((key) => ({
                value: key,
                label: PERIOD_LABELS[key],
              }))}
            />

            {supports("priority") ? (
              <Select
                aria-label="Filtrar por prioridade"
                value={priority}
                onValueChange={(value) =>
                  setFilter({ prioridade: value === "all" ? null : value })
                }
                options={[
                  { value: "all", label: "Todas as prioridades" },
                  ...PRIORITY_FILTERS.map((key) => ({
                    value: key,
                    label: URGENCY_META[key].label,
                  })),
                ]}
              />
            ) : null}

            {supports("status") ? (
              <Select
                aria-label="Filtrar por estado"
                value={status}
                onValueChange={(value) =>
                  setFilter({ estado: value === "all" ? null : value })
                }
                options={[
                  { value: "all", label: "Todos os estados" },
                  ...STATUS_FILTERS.map((key) => ({
                    value: key,
                    label: INCIDENT_STATUS_META[key].label,
                  })),
                ]}
              />
            ) : null}

            {hasActiveFilters ? (
              <Button variant="quiet" size="sm" onClick={clearFilters}>
                <XIcon size={16} />
                Limpar filtros
              </Button>
            ) : null}
          </div>
        </Card>
      </Reveal>

      <Reveal delay={140}>
        <IncidentsChart
          buckets={chart.data}
          failed={resourceFailed(chart)}
          message={resourceFailureMessage(chart, "A série de impacto não respondeu.")}
          periodLabel={PERIOD_LABELS[period]}
        />
      </Reveal>

      <Reveal delay={200}>
        <Card padding="lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Incidentes que exigem atenção</CardTitle>
              <CardDescription className="mt-1">
                Abra um incidente para ver o diagnóstico e os eventos
                correlacionados
              </CardDescription>
            </div>

            <Select
              aria-label="Ordenar incidentes"
              value={sort}
              onValueChange={(value) =>
                setFilter({ ordem: value === "urgency" ? null : value })
              }
              options={SORT_KEYS.map((key) => ({
                value: key,
                label: SORT_LABELS[key],
              }))}
            />
          </div>

          {list?.hasMore ? (
            <Alert tone="warning" className="mt-5">
              {period === "older"
                ? `A origem entrega até ${formatInteger(list.limit)} incidentes por leitura, e "Mais de 24 horas" é recortado a partir deles: parte dos incidentes antigos pode não aparecer. Filtre por prioridade ou estado para alcançá-los.`
                : `A origem entrega até ${formatInteger(list.limit)} incidentes por leitura e há mais neste recorte. Restrinja o período, a prioridade ou o estado para ver o restante.`}
            </Alert>
          ) : null}

          {incidents.status === "loading" && !list ? (
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : failed ? (
            <Unavailable title="Lista indisponível" className="mt-6" minHeight={200}>
              A leitura dos incidentes falhou. Nenhuma lista é exibida para não
              parecer que não há incidentes.
            </Unavailable>
          ) : visibleIncidents.length === 0 ? (
            <Unavailable title="Nenhum incidente encontrado" className="mt-6" minHeight={200}>
              Não há incidentes em &quot;{PERIOD_LABELS[period].toLowerCase()}&quot;
              com estes filtros.
              {period !== "all" ? " Experimente ampliar o período." : ""}
            </Unavailable>
          ) : (
            <>
              <div className="mt-6 overflow-x-auto">
                <IncidentsTable incidents={paged.pageItems} />
              </div>

              <Pagination
                itemLabel="incidentes"
                page={paged.page}
                pageCount={paged.pageCount}
                pageSize={pageSize}
                total={visibleIncidents.length}
                onPageChange={(next) => update({ pagina: next > 1 ? String(next) : null })}
                onPageSizeChange={(size) =>
                  update({
                    itens: size === PAGE_SIZE_OPTIONS[0] ? null : String(size),
                    pagina: null,
                  })
                }
              />
            </>
          )}
        </Card>
      </Reveal>
    </div>
  );
}

function IncidentsTable({ incidents }: { incidents: Incident[] }) {
  return (
    <table className="w-full min-w-[48rem] border-collapse">
      <thead>
        <tr className="text-left text-caption font-normal text-ink-subtle">
          <th scope="col" className="pb-3 pl-3 pr-4">
            Urgência
          </th>
          <th scope="col" className="pb-3 pr-4">
            Incidente
          </th>
          <th scope="col" className="pb-3 pr-4">
            Estado
          </th>
          <th scope="col" className="pb-3 pr-4 text-right">
            Dispositivos
          </th>
          <th scope="col" className="pb-3 pr-4">
            Início
          </th>
          <th scope="col" className="pb-3 pr-4">
            Componente
          </th>
          <th scope="col" className="pb-3">
            <span className="sr-only">Ações</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {incidents.map((incident, index) => {
          const meta = URGENCY_META[incident.urgency];

          return (
            <Reveal
              as="tr"
              key={incident.id}
              index={index}
              variant="rise-sm"
              className={cn(
                "border-t border-line-subtle align-top border-l-4",
                "transition-colors duration-200 hover:bg-surface-muted",
                meta.borderClass,
              )}
            >
              <td className="py-4 pl-3 pr-4">
                <Badge tone={meta.badgeTone}>{meta.label}</Badge>
              </td>
              <td className="py-4 pr-4">
                <Link
                  href={incidentDiagnosisHref(incident.id)}
                  className="focus-ring rounded-field text-body-sm font-semibold text-ink hover:text-ink-brand hover:underline"
                >
                  {incident.code}
                </Link>
                {incident.title ? (
                  <p className="mt-0.5 text-body-sm text-ink">{incident.title}</p>
                ) : null}
                {incident.segment ? (
                  <p className="mt-0.5 text-caption text-ink-brand">{incident.segment}</p>
                ) : null}
              </td>
              <td className="py-4 pr-4">
                {incident.status ? (
                  <Badge tone={incidentStatusTone(incident.status)}>
                    {incidentStatusLabel(incident.status)}
                  </Badge>
                ) : (
                  <span className="text-body-sm text-ink-muted">—</span>
                )}
              </td>
              <td
                className={cn(
                  "py-4 pr-4 text-right text-body-sm font-semibold",
                  DEVICE_COUNT_CLASSES[incident.urgency] ?? "text-ink",
                )}
              >
                {incident.devices === null ? (
                  <span className="font-normal text-ink-muted">não medido</span>
                ) : (
                  formatInteger(incident.devices)
                )}
              </td>
              <td className="whitespace-nowrap py-4 pr-4 text-body-sm text-ink-muted">
                {incident.startedAt}
              </td>
              <td className="py-4 pr-4 text-body-sm text-ink-muted">
                {incident.component}
              </td>
              <td className="py-4">
                <div className="flex justify-end gap-2">
                  <Link
                    href={incidentEventsHref(incident.id)}
                    className={buttonClasses({ variant: "quiet", size: "sm" })}
                  >
                    Eventos
                  </Link>
                  <Link
                    href={incidentDiagnosisHref(incident.id)}
                    className={buttonClasses({ variant: "outline", size: "sm" })}
                  >
                    Diagnóstico
                  </Link>
                </div>
              </td>
            </Reveal>
          );
        })}
      </tbody>
    </table>
  );
}

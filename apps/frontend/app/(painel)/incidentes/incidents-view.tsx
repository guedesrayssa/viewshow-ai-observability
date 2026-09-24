/**
 * @file incidents-view.tsx
 * Busca, filtros e lista dos incidentes que exigem atenção.
 *
 * Cobre a US-N1-01 (visualizar incidentes priorizados) e a US-N1-04
 * (segmentar o incidente): busca por título, filtros por período, dispositivo,
 * região e versão do app, ordenação e a ação de limpar todos os filtros de uma
 * vez.
 *
 * O recorte não é só um filtro de tela: ele é enviado à leitura da telemetria,
 * em `incidents-resource.ts`. A lista se reordena com movimento para que a
 * mudança de ordem seja percebida como um rearranjo, e não como uma troca de
 * conteúdo.
 */

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { IncidentsChart } from "@/app/(painel)/incidentes/incidents-chart";
import {
  DEVICE_COUNT_CLASSES,
  PERIOD_LABELS,
  SORT_LABELS,
  URGENCY_META,
  sortIncidents,
  type ChartPeriodKey,
  type Incident,
  type PeriodKey,
  type SortKey,
} from "@/app/(painel)/incidentes/incidents-data";
import {
  fetchAffectedDevices,
  fetchIncidents,
} from "@/app/(painel)/incidentes/incidents-resource";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ExportIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";
import { formatInteger } from "@/lib/format";

/** Releitura automática da lista, no ritmo de acompanhamento de plantão. */
const REFRESH_MS = 45_000;

export function IncidentsView() {
  const [search, setSearch] = useState("");
  // O recorte mais largo que a origem sustenta é o de 24 horas: a listagem
  // varre baldes por hora, e "todo o período" seria varrer os 30 dias do TTL.
  const [period, setPeriod] = useState<PeriodKey>("1440");
  const [deviceType, setDeviceType] = useState<string>("all");
  const [region, setRegion] = useState<string>("all");
  const [appVersion, setAppVersion] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("urgency");
  const [chartPeriod, setChartPeriod] = useState<ChartPeriodKey>("60");

  const incidents = useResource(
    (revision) =>
      fetchIncidents({ period, deviceType, region, appVersion }, revision),
    [period, deviceType, region, appVersion],
    { refreshMs: REFRESH_MS },
  );

  const chart = useResource(
    (revision) => fetchAffectedDevices(chartPeriod, revision),
    [chartPeriod],
    { refreshMs: REFRESH_MS },
  );

  const hasActiveFilters =
    search !== "" ||
    period !== "1440" ||
    deviceType !== "all" ||
    region !== "all" ||
    appVersion !== "all";

  // As opções dos filtros dimensionais saem do que a leitura trouxe: são as
  // facetas que existem de fato no recorte, e não uma lista fixa que pode
  // oferecer um valor sem nenhum incidente atrás.
  const facets = useMemo(() => {
    const list = incidents.data ?? [];
    const distinct = (pick: (incident: Incident) => string) =>
      Array.from(new Set(list.map(pick).filter(Boolean))).sort();

    return {
      deviceTypes: distinct((incident) => incident.deviceType),
      regions: distinct((incident) => incident.region),
      appVersions: distinct((incident) => incident.appVersion),
    };
  }, [incidents.data]);

  // A leitura já chega recortada pelos filtros; a busca por título é local,
  // porque acompanha a digitação e não justifica uma ida à API por tecla.
  const visibleIncidents = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = (incidents.data ?? []).filter(
      (incident) =>
        query === "" || incident.title.toLowerCase().includes(query),
    );

    return sortIncidents(list, sort);
  }, [incidents.data, search, sort]);

  function clearFilters() {
    setSearch("");
    setPeriod("1440");
    setDeviceType("all");
    setRegion("all");
    setAppVersion("all");
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
          <Button variant="gradient" leadingIcon={<ExportIcon size={18} />}>
            Exportar
          </Button>
        }
      />

      {incidents.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler os incidentes">
          {incidents.error} Tente atualizar em alguns instantes.
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
                placeholder="Buscar incidente"
                aria-label="Buscar incidente"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-10"
              />
            </div>

            <Select
              aria-label="Filtrar por período"
              value={period}
              onValueChange={(value) => setPeriod(value as PeriodKey)}
              options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map(
                (key) => ({
                  value: key,
                  label: PERIOD_LABELS[key],
                }),
              )}
            />

            <Select
              aria-label="Filtrar por dispositivo"
              value={deviceType}
              onValueChange={(value) => setDeviceType(value)}
              options={[
                { value: "all", label: `Todos os dispositivos` },
                ...facets.deviceTypes.map((name) => ({
                  value: name,
                  label: name,
                })),
              ]}
            />

            <Select
              aria-label="Filtrar por região"
              value={region}
              onValueChange={(value) => setRegion(value)}
              options={[
                { value: "all", label: `Todas as regiões` },
                ...facets.regions.map((name) => ({ value: name, label: name })),
              ]}
            />

            <Select
              aria-label="Filtrar por versão do app"
              value={appVersion}
              onValueChange={(value) => setAppVersion(value)}
              options={[
                { value: "all", label: `Todas as versões` },
                ...facets.appVersions.map((name) => ({
                  value: name,
                  label: name,
                })),
              ]}
            />

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
          period={chartPeriod}
          onPeriodChange={setChartPeriod}
        />
      </Reveal>

      <Reveal delay={200}>
        <Card padding="lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Incidentes que exigem atenção</CardTitle>
              <CardDescription className="mt-1">
                Ordenados por urgência, dispositivos impactados e recência
              </CardDescription>
            </div>

            <Select
              aria-label="Ordenar incidentes"
              value={sort}
              onValueChange={(value) => setSort(value as SortKey)}
              options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
                value: key,
                label: SORT_LABELS[key],
              }))}
            />
          </div>

          {incidents.status === "loading" ? (
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : visibleIncidents.length === 0 ? (
            <p className="mt-8 text-center text-body-sm text-ink-muted">
              Nenhum incidente encontrado para os filtros aplicados.
            </p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[42rem] border-collapse">
                <thead>
                  <tr className="text-left text-caption font-medium uppercase text-ink-brand">
                    <th scope="col" className="pb-3 pr-4">
                      Urgência
                    </th>
                    <th scope="col" className="pb-3 pr-4">
                      Incidente
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
                  {visibleIncidents.map((incident, index) => {
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
                        <td className="py-4 pr-4 pl-3">
                          <Badge tone={meta.badgeTone}>{meta.label}</Badge>
                        </td>
                        <td className="py-4 pr-4">
                          <p className="text-body-sm font-semibold text-ink">
                            {incident.title}
                          </p>
                          <p className="mt-0.5 text-caption text-ink-brand">
                            {incident.segment}
                          </p>
                        </td>
                        <td
                          className={cn(
                            "py-4 pr-4 text-right text-body-sm font-semibold",
                            DEVICE_COUNT_CLASSES[incident.urgency] ??
                              "text-ink",
                          )}
                        >
                          {incident.devices === null
                            ? "sem contagem"
                            : formatInteger(incident.devices)}
                        </td>
                        <td className="py-4 pr-4 text-body-sm text-ink-muted">
                          {incident.startedAt}
                        </td>
                        <td className="py-4 pr-4 text-body-sm text-ink-muted">
                          {incident.component}
                        </td>
                        <td className="flex gap-2 py-4">
                          <Link
                            href={`/eventos?incidente=${incident.id}`}
                            className={buttonClasses({
                              variant: "quiet",
                              size: "sm",
                            })}
                          >
                            Ver eventos
                          </Link>
                          <Link
                            href={`/evidencias?incidente=${incident.id}`}
                            className={buttonClasses({
                              variant: "outline",
                              size: "sm",
                            })}
                          >
                            Ver evidências
                          </Link>
                        </td>
                      </Reveal>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Reveal>
    </div>
  );
}

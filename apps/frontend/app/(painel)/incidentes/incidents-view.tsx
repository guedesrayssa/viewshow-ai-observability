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
import { useEffect, useMemo, useRef, useState } from "react";

import { IncidentsChart } from "@/app/(painel)/incidentes/incidents-chart";
import {
  DEVICE_COUNT_CLASSES,
  PERIOD_LABELS,
  SORT_LABELS,
  URGENCY_META,
  type ChartPeriodKey,
  type Incident,
  type PeriodKey,
  type SortKey,
} from "@/app/(painel)/incidentes/incidents-data";
import {
  fetchAffectedDevices,
  fetchIncidentsPage,
  type IncidentsPage,
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
import { selectIncident, useSelectedIncidentId } from "@/lib/selected-incident";

/** Releitura automática da lista, no ritmo de acompanhamento de plantão. */
const REFRESH_MS = 45_000;
const EMPTY_PAGES: IncidentsPage[] = [];

export function IncidentsView() {
  const selectedIncidentId = useSelectedIncidentId();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // O recorte mais largo que a origem sustenta é o de 24 horas: a listagem
  // varre baldes por hora, e "todo o período" seria varrer os 30 dias do TTL.
  const [period, setPeriod] = useState<PeriodKey>("1440");
  const [deviceType, setDeviceType] = useState<string>("all");
  const [region, setRegion] = useState<string>("all");
  const [appVersion, setAppVersion] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("urgency");
  const [chartPeriod, setChartPeriod] = useState<ChartPeriodKey>("60");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const queryKey = [period, deviceType, region, appVersion, debouncedSearch, sort].join("|");
  const queryKeyRef = useRef(queryKey);
  useEffect(() => { queryKeyRef.current = queryKey; }, [queryKey]);
  const query = { period, deviceType, region, appVersion, search: debouncedSearch, sort };

  const incidents = useResource(
    () => fetchIncidentsPage(query),
    [queryKey],
    { refreshMs: REFRESH_MS },
  );
  const [pagination, setPagination] = useState<{ key: string; base?: IncidentsPage; pages: IncidentsPage[]; error: string | null } | null>(null);
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);
  const currentPagination = pagination?.key === queryKey && pagination.base === incidents.data ? pagination : null;
  const extraPages = currentPagination?.pages ?? EMPTY_PAGES;
  const moreError = currentPagination?.error ?? null;
  const loadingMore = loadingMoreKey === queryKey;

  const allIncidents = useMemo(() => {
    const byId = new Map<string, Incident>();
    for (const item of [...(incidents.data?.items ?? []), ...extraPages.flatMap((page) => page.items)]) {
      byId.set(item.id, item);
    }
    return [...byId.values()];
  }, [incidents.data, extraPages]);
  const nextCursor = extraPages.length > 0
    ? extraPages[extraPages.length - 1]?.nextCursor ?? null
    : incidents.data?.nextCursor ?? null;

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const requestedKey = queryKey;
    setLoadingMoreKey(requestedKey);
    const page = await fetchIncidentsPage(query, nextCursor);
    if (queryKeyRef.current === requestedKey) {
      setPagination({
        key: requestedKey,
        base: incidents.data,
        pages: page.source === "api" && page.data ? [...extraPages, page.data] : extraPages,
        error: page.source === "api" && page.data ? null : page.warnings[0]?.message ?? "Não foi possível carregar mais incidentes.",
      });
    }
    setLoadingMoreKey((current) => current === requestedKey ? null : current);
  }

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

  // A API calcula as facetas para todo o recorte, inclusive páginas ainda não abertas.
  const facets = useMemo(() => {
    const list = allIncidents;
    const distinct = (pick: (incident: Incident) => string) =>
      Array.from(new Set(list.map(pick).filter(Boolean))).sort();
    const fromApi = (key: string, fallback: string[]) =>
      incidents.data?.facets[key]?.map((item) => item.value) ?? fallback;

    return {
      deviceTypes: fromApi("deviceTypes", distinct((incident) => incident.deviceType)),
      regions: fromApi("regions", distinct((incident) => incident.region)),
      appVersions: fromApi("appVersions", distinct((incident) => incident.appVersion)),
    };
  }, [incidents.data, allIncidents]);

  const visibleIncidents = allIncidents;

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
              options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => ({
                value: key,
                label: PERIOD_LABELS[key],
              }))}
            />

            <Select
              aria-label="Filtrar por dispositivo"
              value={deviceType}
              onValueChange={(value) => { setDeviceType(value); setRegion("all"); setAppVersion("all"); }}
              options={[
                { value: "all", label: `Todos os dispositivos` },
                ...facets.deviceTypes.map((name) => ({ value: name, label: name })),
              ]}
            />

            <Select
              aria-label="Filtrar por região"
              value={region}
              onValueChange={(value) => { setRegion(value); setDeviceType("all"); setAppVersion("all"); }}
              options={[
                { value: "all", label: `Todas as regiões` },
                ...facets.regions.map((name) => ({ value: name, label: name })),
              ]}
            />

            <Select
              aria-label="Filtrar por versão do app"
              value={appVersion}
              onValueChange={(value) => { setAppVersion(value); setDeviceType("all"); setRegion("all"); }}
              options={[
                { value: "all", label: `Todas as versões` },
                ...facets.appVersions.map((name) => ({ value: name, label: name })),
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
              {incidents.source === "indisponivel" ? "A lista de incidentes está indisponível." : "Nenhum incidente encontrado para os filtros aplicados."}
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
                            DEVICE_COUNT_CLASSES[incident.urgency] ?? "text-ink",
                          )}
                        >
                          {incident.devices === null ? "sem contagem" : formatInteger(incident.devices)}
                        </td>
                        <td className="py-4 pr-4 text-body-sm text-ink-muted">
                          {incident.startedAt}
                        </td>
                        <td className="py-4 pr-4 text-body-sm text-ink-muted">
                          {incident.component}
                        </td>
                        <td className="py-4">
                          <Link
                            href={`/evidencias?incidente=${encodeURIComponent(incident.id)}`}
                            onClick={() => selectIncident(incident.id)}
                            aria-current={selectedIncidentId === incident.id ? "true" : undefined}
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
          {moreError ? <Alert tone="critical" title="Não foi possível carregar a próxima página">{moreError}</Alert> : null}
          {nextCursor && incidents.source === "api" ? (
            <div className="mt-5 flex justify-center">
              <Button variant="outline" loading={loadingMore} onClick={loadMore}>
                Carregar mais incidentes
              </Button>
            </div>
          ) : null}
        </Card>
      </Reveal>
    </div>
  );
}

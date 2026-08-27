/**
 * @file events-view.tsx
 * Busca e filtros globais, abas por tipo, gráfico de volume e tabela de
 * eventos correlacionados.
 *
 * Cobre a seção 5.5 do entendimento de UX e, principalmente, a US-ENG-02 e a
 * US-ENG-03. O recorte inicial (Smart TV · Nordeste · App 4.2.1) chega já
 * aplicado porque a tela continua a investigação do INC-4821, aberta em
 * Incidentes e aprofundada em Evidências.
 */

"use client";

import { useMemo, useState } from "react";

import { EventsChart } from "@/app/(painel)/eventos/events-chart";
import {
  ADVANCED_FILTERS,
  APP_VERSIONS,
  DEVICE_TYPES,
  PERIOD_LABELS,
  REGIONS,
  SOURCES,
  type EventCategory,
  type PeriodKey,
  type VolumePeriodKey,
} from "@/app/(painel)/eventos/events-data";
import {
  fetchEventVolume,
  fetchEvents,
} from "@/app/(painel)/eventos/events-resource";
import { EventsTable } from "@/app/(painel)/eventos/events-table";
import { DataStatus } from "@/components/dashboard/data-status";
import { Unavailable } from "@/components/dashboard/unavailable";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ExportIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";

/** Recorte herdado da investigação do INC-4821. */
const DEFAULT_FILTERS = {
  period: "30" as PeriodKey | "all",
  deviceType: "Smart TV",
  region: "Nordeste",
  appVersion: "App 4.2.1",
  source: "all",
};

export function EventsView() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [period, setPeriod] = useState<PeriodKey | "all">(DEFAULT_FILTERS.period);
  const [deviceType, setDeviceType] = useState(DEFAULT_FILTERS.deviceType);
  const [region, setRegion] = useState(DEFAULT_FILTERS.region);
  const [appVersion, setAppVersion] = useState(DEFAULT_FILTERS.appVersion);
  const [source, setSource] = useState(DEFAULT_FILTERS.source);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [volumePeriod, setVolumePeriod] = useState<VolumePeriodKey>("30");

  const events = useResource(
    () => fetchEvents({ period, category, deviceType, region, appVersion, source }),
    [period, category, deviceType, region, appVersion, source],
  );

  const volume = useResource(
    (revision) => fetchEventVolume(volumePeriod, revision),
    [volumePeriod],
  );

  const hasActiveFilters =
    search !== "" ||
    category !== "all" ||
    period !== DEFAULT_FILTERS.period ||
    deviceType !== DEFAULT_FILTERS.deviceType ||
    region !== DEFAULT_FILTERS.region ||
    appVersion !== DEFAULT_FILTERS.appVersion ||
    source !== DEFAULT_FILTERS.source;

  // A leitura já vem recortada; a busca livre e o tipo continuam locais para
  // responder na hora, sem uma ida à API a cada tecla.
  const visibleEvents = useMemo(() => {
    const query = search.trim().toLowerCase();

    return (events.data?.events ?? []).filter((event) => {
      const matchesQuery =
        query === "" ||
        event.summary.toLowerCase().includes(query) ||
        event.entity.toLowerCase().includes(query) ||
        event.source.toLowerCase().includes(query);
      const matchesCategory = category === "all" || event.category === category;
      const matchesPeriod = period === "all" || event.minutesAgo <= Number(period);
      const matchesDevice = deviceType === "all" || event.deviceType === deviceType;
      const matchesRegion = region === "all" || event.region === region;
      const matchesVersion =
        appVersion === "all" || event.appVersion === appVersion;
      const matchesSource = source === "all" || event.source === source;

      return (
        matchesQuery &&
        matchesCategory &&
        matchesPeriod &&
        matchesDevice &&
        matchesRegion &&
        matchesVersion &&
        matchesSource
      );
    });
  }, [
    events.data,
    search,
    category,
    period,
    deviceType,
    region,
    appVersion,
    source,
  ]);

  function clearFilters() {
    setSearch("");
    setCategory("all");
    setPeriod(DEFAULT_FILTERS.period);
    setDeviceType(DEFAULT_FILTERS.deviceType);
    setRegion(DEFAULT_FILTERS.region);
    setAppVersion(DEFAULT_FILTERS.appVersion);
    setSource(DEFAULT_FILTERS.source);
  }

  function toggleExpanded(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Eventos"
        subtitle="Eventos e sessões sem perder o dado original"
        status={
          <DataStatus
            source={events.source}
            availability={events.availability}
            warnings={events.warnings}
            fetchedAt={events.fetchedAt}
            refreshing={events.refreshing}
            error={events.error}
            onRefresh={events.refresh}
          />
        }
        actions={
          <Button variant="gradient" leadingIcon={<ExportIcon size={18} />}>
            Exportar
          </Button>
        }
      />

      {events.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler os eventos">
          {events.error} Tente atualizar em alguns instantes.
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
                placeholder="Buscar"
                aria-label="Buscar evento"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-10"
              />
            </div>

            <Select
              aria-label="Filtrar por período"
              value={period}
              onValueChange={(value) => setPeriod(value as PeriodKey | "all")}
              options={[
                { value: "all", label: `Todo o período` },
                ...(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => ({
                  value: key,
                  label: PERIOD_LABELS[key],
                })),
              ]}
            />

            <Select
              aria-label="Filtrar por dispositivo"
              value={deviceType}
              onValueChange={(value) => setDeviceType(value)}
              options={[
                { value: "all", label: `Todos os dispositivos` },
                ...DEVICE_TYPES.map((name) => ({ value: name, label: name })),
              ]}
            />

            <Select
              aria-label="Filtrar por região"
              value={region}
              onValueChange={(value) => setRegion(value)}
              options={[
                { value: "all", label: `Todas as regiões` },
                ...REGIONS.map((name) => ({ value: name, label: name })),
              ]}
            />

            <Select
              aria-label="Filtrar por versão do app"
              value={appVersion}
              onValueChange={(value) => setAppVersion(value)}
              options={[
                { value: "all", label: `Todas as versões` },
                ...APP_VERSIONS.map((name) => ({ value: name, label: name })),
              ]}
            />
          </div>
        </Card>
      </Reveal>

      <Reveal delay={140}>
        <Card padding="md">
          <div className="flex flex-wrap items-center gap-2">
            {events.status === "loading"
              ? Array.from({ length: 7 }, (_, index) => (
                  <Skeleton key={index} className="h-9 w-28 rounded-pill" />
                ))
              : null}

            {(events.data?.categories ?? []).map((stat, index) => {
              const active = category === stat.key;

              return (
                <Reveal key={stat.key} index={index} variant="scale">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategory(stat.key)}
                    className={cn(
                      "focus-ring rounded-pill border px-3 py-1.5 text-caption font-medium",
                      "transition-colors duration-200 tabular-nums",
                      active
                        ? "border-brand-blue bg-brand-blue text-ink-inverse"
                        : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                    )}
                  >
                    {stat.label} · {stat.total}
                  </button>
                </Reveal>
              );
            })}

            <div className="ml-auto flex items-center gap-2">
              <Select
                aria-label="Filtrar por fonte"
                value={source}
                onValueChange={(value) => setSource(value)}
                options={[
                  { value: "all", label: `Fonte: todas` },
                  ...SOURCES.map((name) => ({
                    value: name,
                    label: `Fonte: ${name}`,
                  })),
                ]}
              />

              <Button
                variant="outline"
                size="sm"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((current) => !current)}
              >
                Mais filtros · {ADVANCED_FILTERS.length}
              </Button>

              {hasActiveFilters ? (
                <Button variant="quiet" size="sm" onClick={clearFilters}>
                  <XIcon size={16} />
                  Limpar filtros
                </Button>
              ) : null}
            </div>
          </div>

          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              showAdvanced ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-4">
                <p className="text-caption text-ink-muted">
                  Ainda sem tela própria, conforme a disponibilidade dos dados:
                </p>
                {ADVANCED_FILTERS.map((filter) => (
                  <Badge key={filter} tone="neutral">
                    {filter}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </Reveal>

      <Reveal delay={200}>
        <EventsChart
          series={volume.data}
          period={volumePeriod}
          onPeriodChange={setVolumePeriod}
        />
      </Reveal>

      <Reveal delay={260}>
        <Card padding="lg">
          <CardTitle>Eventos correlacionados</CardTitle>
          <CardDescription className="mt-1">
            Selecione uma linha para ver o dado normalizado e a origem
          </CardDescription>

          {events.status === "loading" ? (
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : events.source !== "exemplo" &&
            (events.data?.events.length ?? 0) === 0 ? (
            <Unavailable
              title="Eventos individuais sem fonte nesta fase"
              className="mt-6"
              minHeight={220}
            >
              Os agregados publicados pela telemetria não reconstroem eventos
              um a um. A lista passa a existir quando a instrumentação
              individual das seis categorias entrar no ar.
            </Unavailable>
          ) : (
            <EventsTable
              events={visibleEvents}
              expandedId={expandedId}
              onToggle={toggleExpanded}
            />
          )}
        </Card>
      </Reveal>
    </div>
  );
}

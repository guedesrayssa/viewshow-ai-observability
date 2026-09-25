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
import { useSearchParams } from "next/navigation";

import { EventsChart } from "@/app/(painel)/eventos/events-chart";
import {
  PERIOD_LABELS,
  type CorrelatedEvent,
  type EventCategory,
  type PeriodKey,
  type VolumePeriodKey,
} from "@/app/(painel)/eventos/events-data";
import {
  fetchEventDetail,
  fetchEventVolume,
  fetchEvents,
  eventQueryKey,
  mergeEventPages,
  mergeRequestedEvent,
} from "@/app/(painel)/eventos/events-resource";
import { EventsTable } from "@/app/(painel)/eventos/events-table";
import { DataStatus } from "@/components/dashboard/data-status";
import { Unavailable } from "@/components/dashboard/unavailable";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ExportIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";

const DEFAULT_FILTERS = {
  period: "30" as PeriodKey | "all",
  source: "all",
  correlation: "all" as const,
};

export function EventsView() {
  const searchParams = useSearchParams();
  const incidentId = searchParams.get("incidente") ?? "";
  const requestedEventId = searchParams.get("evento");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [period, setPeriod] = useState<PeriodKey | "all">(
    DEFAULT_FILTERS.period,
  );
  const [source, setSource] = useState(DEFAULT_FILTERS.source);
  const [correlation, setCorrelation] = useState<"all" | "linked" | "unlinked">(
    incidentId ? "linked" : DEFAULT_FILTERS.correlation,
  );
  const [expandedId, setExpandedId] = useState<string | null>(requestedEventId);
  const [volumePeriod, setVolumePeriod] = useState<VolumePeriodKey>("30");
  const eventQuery = {
    incidentId,
    period,
    search,
    category,
    source,
    correlation,
  };
  const filterKey = eventQueryKey(eventQuery);
  const [continuation, setContinuation] = useState<{
    key: string;
    items: CorrelatedEvent[];
    nextCursor: string | null;
    loading: boolean;
    error?: string;
  }>({ key: filterKey, items: [], nextCursor: null, loading: false });

  const events = useResource(
    () => fetchEvents(eventQuery),
    [incidentId, period, search, category, source, correlation],
  );

  const requestedEvent = useResource(
    () => fetchEventDetail(incidentId, requestedEventId ?? ""),
    [incidentId, requestedEventId],
    { enabled: Boolean(requestedEventId) },
  );

  const volume = useResource(
    (revision) => fetchEventVolume(incidentId, volumePeriod, revision),
    [incidentId, volumePeriod],
  );

  const loadedEvents = useMemo(() => {
    const pages = mergeEventPages(
      events.data?.queryKey === filterKey ? events.data.events : [],
      continuation.key === filterKey ? continuation.items : [],
    );
    return mergeRequestedEvent(pages, requestedEvent.data);
  }, [events.data, continuation, filterKey, requestedEvent.data]);
  const nextCursor =
    continuation.key === filterKey && continuation.items.length > 0
      ? continuation.nextCursor
      : events.data?.queryKey === filterKey
        ? events.data.nextCursor
        : null;
  const hasMore =
    continuation.key === filterKey && continuation.items.length > 0
      ? continuation.nextCursor !== null
      : events.data?.queryKey === filterKey && events.data.hasMore;

  async function loadNextPage() {
    if (!nextCursor || continuation.loading) return;
    setContinuation((current) => ({
      key: filterKey,
      items: current.key === filterKey ? current.items : [],
      nextCursor,
      loading: true,
    }));
    try {
      const page = await fetchEvents({ ...eventQuery, cursor: nextCursor });
      setContinuation((current) => ({
        key: filterKey,
        items: mergeEventPages(
          current.key === filterKey ? current.items : [],
          page.data?.events ?? [],
        ),
        nextCursor: page.data?.nextCursor ?? null,
        loading: false,
      }));
    } catch (error) {
      setContinuation((current) => ({
        ...current,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Não foi possível carregar a próxima página.",
      }));
    }
  }

  const hasActiveFilters =
    search !== "" ||
    category !== "all" ||
    period !== DEFAULT_FILTERS.period ||
    source !== DEFAULT_FILTERS.source ||
    (!incidentId && correlation !== DEFAULT_FILTERS.correlation);

  // A leitura já vem recortada; a busca livre e o tipo continuam locais para
  // responder na hora, sem uma ida à API a cada tecla.
  const visibleEvents = useMemo(() => {
    const query = search.trim().toLowerCase();

    return loadedEvents.filter((event) => {
      if (event.id === requestedEventId) return true;
      const matchesQuery =
        query === "" ||
        event.summary.toLowerCase().includes(query) ||
        event.entity.toLowerCase().includes(query) ||
        event.source.toLowerCase().includes(query);
      const matchesCategory = category === "all" || event.category === category;
      const matchesPeriod =
        period === "all" || event.minutesAgo <= Number(period);
      const matchesSource = source === "all" || event.source === source;

      return matchesQuery && matchesCategory && matchesPeriod && matchesSource;
    });
  }, [loadedEvents, requestedEventId, search, category, period, source]);

  function clearFilters() {
    setSearch("");
    setCategory("all");
    setPeriod(DEFAULT_FILTERS.period);
    setSource(DEFAULT_FILTERS.source);
    setCorrelation(incidentId ? "linked" : DEFAULT_FILTERS.correlation);
  }

  function toggleExpanded(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Eventos"
        subtitle={
          incidentId
            ? "Eventos ARGUS correlacionados ao incidente"
            : "Feed global de eventos ARGUS, incluindo os não correlacionados"
        }
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

      {requestedEventId && requestedEvent.status === "error" ? (
        <Alert
          tone="critical"
          title="Não foi possível abrir o evento solicitado"
        >
          {requestedEvent.error} O feed continua disponível abaixo.
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
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                className="pl-10"
              />
            </div>

            <Select
              aria-label="Filtrar por período"
              value={period}
              onValueChange={(value) => {
                setPeriod(value as PeriodKey | "all");
              }}
              options={[
                { value: "all", label: `Todo o período` },
                ...(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => ({
                  value: key,
                  label: PERIOD_LABELS[key],
                })),
              ]}
            />

            {!incidentId ? (
              <Select
                aria-label="Filtrar por correlação"
                value={correlation}
                onValueChange={(value) => {
                  setCorrelation(value as "all" | "linked" | "unlinked");
                }}
                options={[
                  { value: "all", label: "Todos os vínculos" },
                  { value: "linked", label: "Vinculados" },
                  { value: "unlinked", label: "Não correlacionados" },
                ]}
              />
            ) : null}
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
                    onClick={() => {
                      setCategory(stat.key);
                    }}
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
                onValueChange={(value) => {
                  setSource(value);
                }}
                options={[
                  { value: "all", label: `Fonte: todas` },
                  ...(events.data?.sourceDatasets ?? []).map((name) => ({
                    value: name,
                    label: `Fonte: ${name}`,
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
          </div>
        </Card>
      </Reveal>

      <Reveal delay={200}>
        <EventsChart
          series={volume.data}
          status={volume.status}
          error={volume.error}
          period={volumePeriod}
          onPeriodChange={setVolumePeriod}
        />
      </Reveal>

      <Reveal delay={260}>
        <Card padding="lg">
          <CardTitle>
            {incidentId ? "Eventos correlacionados" : "Todos os eventos"}
          </CardTitle>
          <CardDescription className="mt-1">
            Selecione uma linha para ver o dado normalizado e a origem
          </CardDescription>

          {events.status === "loading" ? (
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : loadedEvents.length === 0 ? (
            <Unavailable
              title="Nenhum evento encontrado"
              className="mt-6"
              minHeight={220}
            >
              Não há registros ARGUS nesta janela e com estes filtros.
            </Unavailable>
          ) : (
            <>
              <EventsTable
                events={visibleEvents}
                expandedId={expandedId}
                onToggle={toggleExpanded}
              />
              {continuation.key === filterKey && continuation.error ? (
                <Alert
                  tone="critical"
                  title="Não foi possível carregar mais eventos"
                >
                  {continuation.error}
                </Alert>
              ) : null}
              {hasMore && nextCursor ? (
                <div className="mt-5 flex justify-end">
                  <Button
                    variant="outline"
                    disabled={continuation.loading}
                    onClick={loadNextPage}
                  >
                    {continuation.loading ? "Carregando…" : "Carregar mais"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </Reveal>
    </div>
  );
}

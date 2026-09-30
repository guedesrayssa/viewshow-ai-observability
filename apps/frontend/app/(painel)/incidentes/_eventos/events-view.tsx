/**
 * @file events-view.tsx
 * Lista de eventos ARGUS com busca, filtros, gráfico de volume e detalhe
 * expansível por linha.
 *
 * Serve às duas visões de eventos, que antes eram uma tela solta na
 * navegação lateral:
 *
 * - `incident`: aba "Eventos correlacionados" do detalhe de um incidente
 *   (`/incidentes/detalhe/eventos?incidente=`), sempre com o incidente no
 *   cabeçalho e o caminho de volta a ele;
 * - `feed`: feed global da seção Incidentes (`/incidentes/feed-eventos`),
 *   incluindo o que ainda não foi correlacionado.
 *
 * Cobre a seção 5.5 do entendimento de UX e, principalmente, a US-ENG-02 e a
 * US-ENG-03. Os filtros moram na URL: recarregar ou compartilhar o link
 * reproduz o mesmo recorte.
 */

"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EventsChart } from "@/app/(painel)/incidentes/_eventos/events-chart";
import {
  CATEGORY_LABELS,
  PERIOD_KEYS,
  PERIOD_LABELS,
  SORT_LABELS,
  type CorrelatedEvent,
  type EventCategory,
  type EventSort,
  type PeriodKey,
} from "@/app/(painel)/incidentes/_eventos/events-data";
import {
  eventQueryKey,
  fetchEventDetail,
  fetchEventVolume,
  fetchEvents,
  mergeEventPages,
  mergeRequestedEvent,
} from "@/app/(painel)/incidentes/_eventos/events-resource";
import { EventsTable } from "@/app/(painel)/incidentes/_eventos/events-table";
import { fetchIncidentSummary } from "@/app/(painel)/incidentes/detalhe/evidence-resource";
import { IncidentDetailHeader } from "@/app/(painel)/incidentes/detalhe/incident-detail-header";
import { IncidentsSectionTabs } from "@/components/incidents/incidents-section-tabs";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ExportIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { Input, Label } from "@/components/ui/input";
import { LoadMore } from "@/components/ui/pagination";
import { SegmentedFilter } from "@/components/ui/segmented-filter";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useQueryParams } from "@/hooks/use-query-params";
import { useResource } from "@/hooks/use-resource";
import { resourceFailed, resourceFailureMessage } from "@/lib/data/resource-state";
import { downloadCsv, exportFileName } from "@/lib/export";

type Correlation = "all" | "linked" | "unlinked";

const CORRELATIONS: Correlation[] = ["all", "linked", "unlinked"];
const SORTS: EventSort[] = ["recent", "oldest"];

/** Período da tela: um dos prontos ou um intervalo com início e fim. */
type PeriodChoice = PeriodKey | "custom";
const PERIOD_CHOICES: PeriodChoice[] = [...PERIOD_KEYS, "custom"];
const CUSTOM_PERIOD_LABEL = "Intervalo personalizado";

/**
 * Lê o intervalo da URL (`de`/`ate`, no formato do campo datetime-local, no
 * fuso de quem usa) e o converte para ISO. Devolve `null` enquanto faltar um
 * lado ou o início não vier antes do fim.
 */
function parseRange(from: string, to: string): { from: string; to: string } | null {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (start >= end) return null;
  return { from: start.toISOString(), to: end.toISOString() };
}

export type EventsViewProps = {
  mode: "incident" | "feed";
};

export function EventsView({ mode }: EventsViewProps) {
  const searchParams = useSearchParams();
  const incidentId = mode === "incident" ? (searchParams.get("incidente") ?? "") : "";

  if (mode === "incident" && !incidentId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Eventos correlacionados" />
        <Unavailable title="Escolha um incidente" minHeight={240}>
          Os eventos correlacionados são sempre de um incidente. Abra um
          incidente na lista, ou use o feed de eventos para ver tudo o que
          chegou da origem.
        </Unavailable>
      </div>
    );
  }

  // A chave reinicia paginação e linha aberta ao trocar de incidente.
  return <EventsScreen key={incidentId || "feed"} mode={mode} incidentId={incidentId} />;
}

function EventsScreen({
  mode,
  incidentId,
}: {
  mode: "incident" | "feed";
  incidentId: string;
}) {
  const { searchParams, read, update } = useQueryParams();
  const requestedEventId = searchParams.get("evento");

  // O padrão é todo o período, nas duas visões: os eventos podem ser
  // anteriores às últimas horas, e as janelas relativas contam a partir de
  // agora — com um dataset histórico, "últimas 24 horas" abria vazio.
  const defaultPeriod: PeriodKey = "all";
  const periodChoice = read<PeriodChoice>("periodo", defaultPeriod, PERIOD_CHOICES);
  const rangeFrom = searchParams.get("de") ?? "";
  const rangeTo = searchParams.get("ate") ?? "";
  const custom = periodChoice === "custom";
  const range = custom ? parseRange(rangeFrom, rangeTo) : null;
  // Com o intervalo incompleto, nada é lido: uma janela qualquer no lugar
  // mostraria um recorte que ninguém escolheu.
  const rangePending = custom && range === null;
  const period: PeriodKey = custom ? "all" : periodChoice;
  const periodLabel = custom ? CUSTOM_PERIOD_LABEL : PERIOD_LABELS[period];
  const category = read<EventCategory | "all">("categoria", "all", [
    "all",
    ...(Object.keys(CATEGORY_LABELS) as EventCategory[]),
  ]);
  const source = searchParams.get("fonte") ?? "all";
  const correlation =
    mode === "incident" ? "all" : read<Correlation>("vinculo", "all", CORRELATIONS);
  const sort = read<EventSort>("ordem", "recent", SORTS);

  // O campo responde na hora; a URL e a leitura só mudam quando a digitação
  // para, e não a cada tecla.
  const [searchInput, setSearchInput] = useState(searchParams.get("busca") ?? "");
  const search = useDebouncedValue(searchInput.trim(), 350);
  useEffect(() => {
    if ((searchParams.get("busca") ?? "") !== search) update({ busca: search || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // A linha aberta acompanha o `?evento=` da URL: um novo evento pedido por
  // link abre por cima da escolha anterior.
  const [expanded, setExpanded] = useState<{ for: string | null; id: string | null }>({
    for: requestedEventId,
    id: requestedEventId,
  });
  const expandedId = expanded.for === requestedEventId ? expanded.id : requestedEventId;

  const eventQuery = {
    incidentId,
    period,
    search,
    category,
    source,
    correlation,
    sort,
    range,
  };
  const filterKey = eventQueryKey(eventQuery);
  const [continuation, setContinuation] = useState<{
    key: string;
    items: CorrelatedEvent[];
    nextCursor: string | null;
    loading: boolean;
    error?: string;
  }>({ key: filterKey, items: [], nextCursor: null, loading: false });

  const summary = useResource(() => fetchIncidentSummary(incidentId), [incidentId], {
    enabled: mode === "incident",
  });

  const events = useResource(
    () => fetchEvents(eventQuery),
    [incidentId, period, search, category, source, correlation, sort, range?.from, range?.to],
    { enabled: !rangePending },
  );

  const requestedEvent = useResource(
    () => fetchEventDetail(incidentId, requestedEventId ?? ""),
    [incidentId, requestedEventId],
    { enabled: Boolean(requestedEventId) },
  );

  // O gráfico lê o mesmo recorte da lista, e não só o período.
  const volume = useResource(
    (revision) => fetchEventVolume(eventQuery, revision),
    [incidentId, period, search, category, source, correlation, range?.from, range?.to],
    { enabled: !rangePending },
  );

  const current = events.data?.queryKey === filterKey ? events.data : undefined;
  const ownContinuation = continuation.key === filterKey ? continuation : undefined;

  const loadedEvents = useMemo(() => {
    const pages = mergeEventPages(current?.events ?? [], ownContinuation?.items ?? []);
    return mergeRequestedEvent(pages, requestedEvent.data);
  }, [current, ownContinuation, requestedEvent.data]);

  const nextCursor =
    ownContinuation && ownContinuation.items.length > 0
      ? ownContinuation.nextCursor
      : (current?.nextCursor ?? null);
  const hasMore = nextCursor !== null;

  // Total do recorte: com uma categoria escolhida, o da categoria; sem, a
  // soma de todas.
  const total = useMemo(() => {
    if (!current) return null;
    if (category === "all") return current.total;
    const stat = current.categories.find((item) => item.key === category);
    return stat ? Number(stat.total.replace(/\D/g, "")) : null;
  }, [current, category]);

  async function loadNextPage() {
    if (!nextCursor || continuation.loading) return;
    setContinuation((state) => ({
      key: filterKey,
      items: state.key === filterKey ? state.items : [],
      nextCursor,
      loading: true,
    }));
    const page = await fetchEvents({ ...eventQuery, cursor: nextCursor });
    if (!page.data) {
      setContinuation((state) => ({
        ...state,
        loading: false,
        error:
          page.warnings[0]?.message ?? "Não foi possível carregar a próxima página.",
      }));
      return;
    }
    setContinuation((state) => ({
      key: filterKey,
      items: mergeEventPages(
        state.key === filterKey ? state.items : [],
        page.data?.events ?? [],
      ),
      nextCursor: page.data?.nextCursor ?? null,
      loading: false,
    }));
  }

  const hasActiveFilters =
    searchInput !== "" ||
    category !== "all" ||
    periodChoice !== defaultPeriod ||
    source !== "all" ||
    correlation !== "all" ||
    sort !== "recent";

  function clearFilters() {
    setSearchInput("");
    update({
      busca: null,
      categoria: null,
      periodo: null,
      de: null,
      ate: null,
      fonte: null,
      vinculo: null,
      ordem: null,
    });
  }

  function exportEvents() {
    downloadCsv(
      exportFileName(mode === "incident" ? `eventos-${incidentId}` : "feed-eventos"),
      loadedEvents,
      [
        { header: "Horário", value: (event) => event.detail.timestamp },
        { header: "Tipo", value: (event) => CATEGORY_LABELS[event.category] },
        { header: "Fonte", value: (event) => event.source },
        { header: "Entidade", value: (event) => event.entity },
        { header: "Medidas", value: (event) => event.detail.value },
        { header: "Vínculo", value: (event) => event.quality.label },
        { header: "Incidentes", value: (event) => event.incidentIds.join(" ") },
        { header: "Registro de origem", value: (event) => event.detail.sourceRecordId },
        { header: "ID do evento", value: (event) => event.id },
      ],
    );
  }

  const failed = resourceFailed(events);
  const status = (
    <DataStatus
      source={events.source}
      availability={events.availability}
      warnings={events.warnings}
      fetchedAt={events.fetchedAt}
      refreshing={events.refreshing}
      error={events.error}
      onRefresh={events.refresh}
    />
  );
  const exportButton = (
    <Button
      variant="gradient"
      leadingIcon={<ExportIcon size={18} />}
      disabled={loadedEvents.length === 0}
      onClick={exportEvents}
      title="Exporta em CSV os eventos carregados na tela, no recorte atual"
    >
      Exportar
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      {mode === "incident" ? (
        <IncidentDetailHeader
          incidentId={incidentId}
          section="events"
          incident={summary.data}
          status={status}
          actions={exportButton}
        />
      ) : (
        <>
          <PageHeader
            title="Feed de eventos"
            subtitle="Todos os eventos ARGUS, incluindo os ainda não correlacionados a um incidente"
            status={status}
            actions={exportButton}
          />
          <IncidentsSectionTabs />
        </>
      )}

      {failed ? (
        <Alert tone="critical" title="Não foi possível ler os eventos">
          {resourceFailureMessage(events, "A origem de eventos não respondeu.")}{" "}
          Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      {requestedEventId && resourceFailed(requestedEvent) ? (
        <Alert tone="critical" title="Não foi possível abrir o evento solicitado">
          {resourceFailureMessage(requestedEvent, "O evento não foi encontrado.")}{" "}
          A lista continua disponível abaixo.
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
                placeholder="Buscar por entidade, fonte ou medida"
                aria-label="Buscar evento"
                value={searchInput}
                maxLength={100}
                onChange={(event) => setSearchInput(event.target.value)}
                className="pl-10"
              />
            </div>

            <Select
              aria-label="Filtrar por período"
              value={periodChoice}
              onValueChange={(value) =>
                update({
                  periodo: value === defaultPeriod ? null : value,
                  // Sair do intervalo personalizado limpa as datas dele.
                  ...(value === "custom" ? {} : { de: null, ate: null }),
                })
              }
              options={PERIOD_CHOICES.map((key) => ({
                value: key,
                label: key === "custom" ? CUSTOM_PERIOD_LABEL : PERIOD_LABELS[key],
              }))}
            />

            {mode === "feed" ? (
              <Select
                aria-label="Filtrar por correlação"
                value={correlation}
                onValueChange={(value) =>
                  update({ vinculo: value === "all" ? null : value })
                }
                options={[
                  { value: "all", label: "Todos os vínculos" },
                  { value: "linked", label: "Correlacionados" },
                  { value: "unlinked", label: "Não correlacionados" },
                ]}
              />
            ) : null}

            <Select
              aria-label="Filtrar por fonte"
              value={source}
              onValueChange={(value) => update({ fonte: value === "all" ? null : value })}
              options={[
                { value: "all", label: "Fonte: todas" },
                ...Array.from(
                  new Set([
                    ...(current?.sourceDatasets ?? []),
                    ...(source !== "all" ? [source] : []),
                  ]),
                ).map((name) => ({ value: name, label: `Fonte: ${name}` })),
              ]}
            />

            <Select
              aria-label="Ordenar eventos"
              value={sort}
              onValueChange={(value) => update({ ordem: value === "recent" ? null : value })}
              options={SORTS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
            />

            {hasActiveFilters ? (
              <Button variant="quiet" size="sm" onClick={clearFilters}>
                <XIcon size={16} />
                Limpar filtros
              </Button>
            ) : null}
          </div>

          {custom ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eventos-de">De</Label>
                <Input
                  id="eventos-de"
                  type="datetime-local"
                  fieldSize="sm"
                  value={rangeFrom}
                  max={rangeTo || undefined}
                  onChange={(event) => update({ de: event.target.value || null })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eventos-ate">Até</Label>
                <Input
                  id="eventos-ate"
                  type="datetime-local"
                  fieldSize="sm"
                  value={rangeTo}
                  min={rangeFrom || undefined}
                  onChange={(event) => update({ ate: event.target.value || null })}
                />
              </div>
              {rangePending ? (
                <p className="pb-2 text-caption text-ink-muted" role="status">
                  {rangeFrom && rangeTo
                    ? "O início precisa ser anterior ao fim."
                    : "Informe o início e o fim do intervalo."}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4">
            {events.status === "loading" && !current && !rangePending ? (
              <Skeleton className="h-9 w-80 max-w-full rounded-field" />
            ) : current && current.categories.length > 0 ? (
              <SegmentedFilter
                label="Tipo"
                groupLabel="Filtrar por tipo de evento"
                value={category}
                options={current.categories.map((stat) => ({
                  key: stat.key,
                  label: stat.label,
                  total: stat.total,
                }))}
                onChange={(key) => update({ categoria: key === "all" ? null : key })}
              />
            ) : null}
          </div>
        </Card>
      </Reveal>

      <Reveal delay={140}>
        <EventsChart
          series={volume.data}
          status={
            rangePending
              ? "error"
              : volume.status === "loading"
                ? "loading"
                : volume.data
                  ? "ready"
                  : "error"
          }
          error={
            rangePending
              ? "Defina o intervalo para ver o volume."
              : resourceFailureMessage(
                  volume,
                  "O agregado temporal de eventos não foi publicado.",
                )
          }
          period={period}
          periodLabel={periodLabel}
        />
      </Reveal>

      <Reveal delay={200}>
        <Card padding="lg">
          <CardTitle>
            {mode === "incident" ? "Eventos correlacionados" : "Todos os eventos"}
          </CardTitle>
          <CardDescription className="mt-1">
            Expanda uma linha para ver o dado normalizado e a origem
          </CardDescription>

          {rangePending ? (
            <Unavailable title="Defina o intervalo" className="mt-6" minHeight={220}>
              Escolha o início e o fim do intervalo personalizado para listar
              os eventos.
            </Unavailable>
          ) : events.status === "loading" && !current ? (
            <div className="mt-6 flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : failed ? (
            <Unavailable title="Eventos indisponíveis" className="mt-6" minHeight={220}>
              A leitura dos eventos falhou. Nenhuma lista é exibida para não
              parecer que o recorte está vazio.
            </Unavailable>
          ) : loadedEvents.length === 0 ? (
            <Unavailable title="Nenhum evento encontrado" className="mt-6" minHeight={220}>
              {mode === "incident"
                ? "Nenhum evento foi correlacionado a este incidente com estes filtros."
                : `Não há registros ARGUS em "${periodLabel.toLowerCase()}" com estes filtros.`}
              {periodChoice !== "all" ? " Experimente ampliar o período." : ""}
            </Unavailable>
          ) : (
            <>
              <EventsTable
                events={loadedEvents}
                expandedId={expandedId}
                onToggle={(id) =>
                  setExpanded({ for: requestedEventId, id: expandedId === id ? null : id })
                }
                showIncidentLinks={mode === "feed"}
              />
              {ownContinuation?.error ? (
                <Alert tone="critical" title="Não foi possível carregar mais eventos" className="mt-4">
                  {ownContinuation.error}
                </Alert>
              ) : null}
              <LoadMore
                itemLabel="eventos"
                shown={loadedEvents.length}
                total={total}
                hasMore={hasMore}
                loading={Boolean(ownContinuation?.loading)}
                onLoadMore={loadNextPage}
              />
            </>
          )}
        </Card>
      </Reveal>
    </div>
  );
}

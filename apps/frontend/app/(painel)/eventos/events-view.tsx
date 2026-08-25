/**
 * @file events-view.tsx
 * Busca e filtros globais, abas por tipo, gráfico de volume e tabela de
 * eventos correlacionados.
 *
 * Cobre a seção 5.5 do entendimento de UX e, principalmente, a US-ENG-02 e a
 * US-ENG-03. O recorte inicial (Smart TV · Nordeste · App 4.2.1) chega já
 * aplicado porque a tela continua a investigação do INC-4821, aberta em
 * Incidentes e aprofundada em Evidências. Os dados são um exemplo fixo,
 * enquanto a integração com a telemetria não existe.
 */

"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

import { EventsChart } from "@/app/(painel)/eventos/events-chart";
import { EventsTable } from "@/app/(painel)/eventos/events-table";
import {
  ADVANCED_FILTERS,
  APP_VERSIONS,
  CATEGORY_STATS,
  DEVICE_TYPES,
  EVENTS,
  PERIOD_LABELS,
  REGIONS,
  SOURCES,
  type EventCategory,
  type PeriodKey,
} from "@/app/(painel)/eventos/events-data";

/** Recorte herdado da investigação do INC-4821, usado como base de comparação. */
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
  const [expandedId, setExpandedId] = useState<string | null>(EVENTS[0]?.id ?? null);

  const hasActiveFilters =
    search !== "" ||
    category !== "all" ||
    period !== DEFAULT_FILTERS.period ||
    deviceType !== DEFAULT_FILTERS.deviceType ||
    region !== DEFAULT_FILTERS.region ||
    appVersion !== DEFAULT_FILTERS.appVersion ||
    source !== DEFAULT_FILTERS.source;

  const filteredEvents = useMemo(() => {
    const query = search.trim().toLowerCase();

    return EVENTS.filter((event) => {
      const matchesQuery =
        query === "" ||
        event.summary.toLowerCase().includes(query) ||
        event.entity.toLowerCase().includes(query) ||
        event.source.toLowerCase().includes(query);
      const matchesCategory = category === "all" || event.category === category;
      const matchesPeriod = period === "all" || event.minutesAgo <= Number(period);
      const matchesDevice = deviceType === "all" || event.deviceType === deviceType;
      const matchesRegion = region === "all" || event.region === region;
      const matchesVersion = appVersion === "all" || event.appVersion === appVersion;
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
  }, [search, category, period, deviceType, region, appVersion, source]);

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
            onChange={(event) => setPeriod(event.target.value as PeriodKey | "all")}
          >
            <option value="all">Todo o período</option>
            {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => (
              <option key={key} value={key}>
                {PERIOD_LABELS[key]}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Filtrar por dispositivo"
            value={deviceType}
            onChange={(event) => setDeviceType(event.target.value)}
          >
            <option value="all">Todos os dispositivos</option>
            {DEVICE_TYPES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Filtrar por região"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
          >
            <option value="all">Todas as regiões</option>
            {REGIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Filtrar por versão do app"
            value={appVersion}
            onChange={(event) => setAppVersion(event.target.value)}
          >
            <option value="all">Todas as versões</option>
            {APP_VERSIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card padding="md">
        <div className="flex flex-wrap items-center gap-2">
          {CATEGORY_STATS.map((stat) => {
            const active = category === stat.key;

            return (
              <button
                key={stat.key}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(stat.key)}
                className={cn(
                  "focus-ring rounded-pill px-3.5 py-2 text-body-sm font-medium transition-colors",
                  active
                    ? "bg-brand-blue text-ink-inverse"
                    : "text-ink-muted hover:bg-canvas hover:text-ink",
                )}
              >
                {stat.label} · {stat.total}
              </button>
            );
          })}

          <div className="ml-auto flex items-center gap-2">
            <Select
              aria-label="Filtrar por fonte"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            >
              <option value="all">Fonte: todas</option>
              {SOURCES.map((name) => (
                <option key={name} value={name}>
                  Fonte: {name}
                </option>
              ))}
            </Select>

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

        {showAdvanced ? (
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
        ) : null}
      </Card>

      <EventsChart />

      <Card padding="lg">
        <CardTitle>Eventos correlacionados</CardTitle>
        <CardDescription className="mt-1">
          Selecione uma linha para ver o dado normalizado e a origem
        </CardDescription>

        <EventsTable events={filteredEvents} expandedId={expandedId} onToggle={toggleExpanded} />
      </Card>
    </div>
  );
}

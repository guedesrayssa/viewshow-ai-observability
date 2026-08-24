/**
 * @file incidents-view.tsx
 * Barra de busca e filtros, e lista de incidentes que exigem atenção.
 *
 * Cobre a US-N1-01 (visualizar incidentes priorizados) e a US-N1-04
 * (segmentar o incidente): busca por título, filtros por período,
 * dispositivo, região e versão do app, ordenação e a ação de limpar todos
 * os filtros de uma vez. Os dados são um exemplo fixo, enquanto a
 * integração com a telemetria não existe.
 */

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { SearchIcon, XIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

import { IncidentsChart } from "@/app/(painel)/incidentes/incidents-chart";

type Urgency = "P1" | "P2" | "P3" | "P4";

type Incident = {
  id: string;
  urgency: Urgency;
  title: string;
  segment: string;
  devices: number;
  startedAt: string;
  startedMinutesAgo: number;
  component: string;
  deviceType: string;
  region: string;
  appVersion: string;
};

const URGENCY_META: Record<
  Urgency,
  { label: string; badgeTone: BadgeTone; borderClass: string }
> = {
  P1: { label: "P1 Crítico", badgeTone: "critical", borderClass: "border-l-critical" },
  P2: { label: "P2 Alto", badgeTone: "warning", borderClass: "border-l-brand-orange" },
  P3: { label: "P3 Médio", badgeTone: "info", borderClass: "border-l-brand-blue-light" },
  P4: { label: "P4 Baixo", badgeTone: "success", borderClass: "border-l-success" },
};

/** Cor do valor de dispositivos afetados, reforçando a urgência. */
const DEVICE_COUNT_CLASSES: Partial<Record<Urgency, string>> = {
  P1: "text-critical",
  P2: "text-brand-orange",
};

/** Exemplo fixo, com os mesmos casos do protótipo de alta fidelidade. */
const INCIDENTS: Incident[] = [
  {
    id: "falhas-reproducao-tvs-lg",
    urgency: "P1",
    title: "Falhas de reprodução em TVs LG",
    segment: "12,4 mil sessões · Nordeste · webOS 6.0",
    devices: 8420,
    startedAt: "09:18",
    startedMinutesAgo: 12,
    component: "Player",
    deviceType: "Smart TV",
    region: "Nordeste",
    appVersion: "App 4.2.1",
  },
  {
    id: "timeout-cdn-nordeste",
    urgency: "P2",
    title: "Timeout de CDN no Nordeste",
    segment: "3,2 mil sessões · POP Recife · Fastly",
    devices: 2150,
    startedAt: "08:52",
    startedMinutesAgo: 38,
    component: "CDN",
    deviceType: "Multiplataforma",
    region: "Nordeste",
    appVersion: "App 4.1.8",
  },
  {
    id: "licencas-drm-tvs-samsung",
    urgency: "P3",
    title: "Licenças DRM expiradas em TVs Samsung",
    segment: "1,1 mil sessões · Tizen 7 · conteúdo VOD",
    devices: 824,
    startedAt: "08:36",
    startedMinutesAgo: 54,
    component: "DRM",
    deviceType: "Smart TV",
    region: "Sul",
    appVersion: "App 4.2.1",
  },
  {
    id: "tokens-autenticacao-invalidos",
    urgency: "P4",
    title: "Tokens de autenticação inválidos",
    segment: "430 sessões · múltiplas plataformas",
    devices: 390,
    startedAt: "07:58",
    startedMinutesAgo: 92,
    component: "Identidade",
    deviceType: "Mobile",
    region: "Nacional",
    appVersion: "App 4.0.5",
  },
];

const DEVICE_TYPES = Array.from(new Set(INCIDENTS.map((incident) => incident.deviceType)));
const REGIONS = Array.from(new Set(INCIDENTS.map((incident) => incident.region)));
const APP_VERSIONS = Array.from(new Set(INCIDENTS.map((incident) => incident.appVersion)));

type PeriodKey = "30" | "60" | "360" | "1440";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30": "Últimos 30 min",
  "60": "Última hora",
  "360": "Últimas 6 horas",
  "1440": "Últimas 24 horas",
};

type SortKey = "urgency" | "devices" | "recent";

const SORT_LABELS: Record<SortKey, string> = {
  urgency: "Ordenar: maior urgência",
  devices: "Ordenar: mais dispositivos",
  recent: "Ordenar: mais recente",
};

function sortIncidents(incidents: Incident[], sort: SortKey): Incident[] {
  const sorted = [...incidents];

  if (sort === "devices") {
    sorted.sort((a, b) => b.devices - a.devices);
  } else if (sort === "recent") {
    sorted.sort((a, b) => a.startedMinutesAgo - b.startedMinutesAgo);
  } else {
    sorted.sort((a, b) => a.urgency.localeCompare(b.urgency));
  }

  return sorted;
}

export function IncidentsView() {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PeriodKey | "all">("all");
  const [deviceType, setDeviceType] = useState<string>("all");
  const [region, setRegion] = useState<string>("all");
  const [appVersion, setAppVersion] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("urgency");

  const hasActiveFilters =
    search !== "" ||
    period !== "all" ||
    deviceType !== "all" ||
    region !== "all" ||
    appVersion !== "all";

  const filteredIncidents = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = INCIDENTS.filter((incident) => {
      const matchesQuery =
        query === "" || incident.title.toLowerCase().includes(query);
      const matchesPeriod =
        period === "all" || incident.startedMinutesAgo <= Number(period);
      const matchesDevice = deviceType === "all" || incident.deviceType === deviceType;
      const matchesRegion = region === "all" || incident.region === region;
      const matchesVersion = appVersion === "all" || incident.appVersion === appVersion;

      return (
        matchesQuery && matchesPeriod && matchesDevice && matchesRegion && matchesVersion
      );
    });

    return sortIncidents(filtered, sort);
  }, [search, period, deviceType, region, appVersion, sort]);

  function clearFilters() {
    setSearch("");
    setPeriod("all");
    setDeviceType("all");
    setRegion("all");
    setAppVersion("all");
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
              placeholder="Buscar incidente"
              aria-label="Buscar incidente"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-10"
            />
          </div>

          <Select
            aria-label="Filtrar por período"
            fieldSize="sm"
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
            fieldSize="sm"
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
            fieldSize="sm"
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
            fieldSize="sm"
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

          {hasActiveFilters ? (
            <Button variant="quiet" size="sm" onClick={clearFilters}>
              <XIcon size={16} />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      </Card>

      <IncidentsChart />

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
            fieldSize="sm"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </Select>
        </div>

        {filteredIncidents.length === 0 ? (
          <p className="mt-8 text-center text-body-sm text-ink-muted">
            Nenhum incidente encontrado para os filtros aplicados.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse">
              <thead>
                <tr className="text-left text-caption font-medium uppercase text-brand-blue">
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
                {filteredIncidents.map((incident) => {
                  const meta = URGENCY_META[incident.urgency];

                  return (
                    <tr
                      key={incident.id}
                      className={cn(
                        "border-t border-line-subtle align-top",
                        "border-l-4",
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
                        <p className="mt-0.5 text-caption text-brand-blue">
                          {incident.segment}
                        </p>
                      </td>
                      <td
                        className={cn(
                          "py-4 pr-4 text-right text-body-sm font-semibold",
                          DEVICE_COUNT_CLASSES[incident.urgency] ?? "text-ink",
                        )}
                      >
                        {incident.devices.toLocaleString("pt-BR")}
                      </td>
                      <td className="py-4 pr-4 text-body-sm text-ink-muted">
                        {incident.startedAt}
                      </td>
                      <td className="py-4 pr-4 text-body-sm text-ink-muted">
                        {incident.component}
                      </td>
                      <td className="py-4">
                        <Link
                          href={`/incidentes/${incident.id}`}
                          className={buttonClasses({ variant: "outline", size: "sm" })}
                        >
                          Ver detalhes
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

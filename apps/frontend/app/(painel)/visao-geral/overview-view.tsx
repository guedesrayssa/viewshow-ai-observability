/**
 * @file overview-view.tsx
 * Conteúdo da Visão Geral.
 *
 * Lê o estado do ecossistema para o recorte selecionado e o mantém atualizado
 * enquanto a tela estiver aberta. Cada mudança de filtro é uma nova leitura, e
 * cada leitura reanima os números e as séries — é assim que o hub mostra que o
 * que está na tela é o agora, e não uma fotografia.
 */

"use client";

import { useCallback, useState } from "react";

import {
  fetchOverview,
  type OverviewFilters,
} from "@/app/(painel)/visao-geral/overview-resource";
import { Reveal } from "@/components/motion/reveal";
import { DataStatus } from "@/components/dashboard/data-status";
import {
  DEFAULT_DASHBOARD_FILTERS,
  FilterBar,
  type DashboardFilters,
} from "@/components/dashboard/filter-bar";
import {
  ExperienceHealthCard,
  ExperienceHealthCardSkeleton,
} from "@/components/dashboard/experience-health-card";
import {
  IncidentsCard,
  IncidentsCardSkeleton,
} from "@/components/dashboard/incidents-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/stat-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExportIcon } from "@/components/ui/icons";
import { useResource } from "@/hooks/use-resource";
import type { StatAccent } from "@/lib/dashboard-data";

/** Releitura automática do hub, no ritmo do "tempo quase real" do produto. */
const REFRESH_MS = 30_000;

/** Faixas dos três indicadores, usadas também no espaço reservado. */
const STAT_ACCENTS: StatAccent[] = ["critical", "warning", "info"];

export function OverviewView() {
  const [filters, setFilters] = useState<DashboardFilters>(
    DEFAULT_DASHBOARD_FILTERS,
  );

  const overview = useResource(
    (revision) => fetchOverview(toQuery(filters), revision),
    [filters.timeRange, filters.device, filters.region, filters.appVersion],
    { refreshMs: REFRESH_MS },
  );

  const onFilterChange = useCallback((patch: Partial<DashboardFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const data = overview.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão Geral"
        subtitle="Estado do ecossistema em tempo quase real"
        status={
          <DataStatus
            source={overview.source}
            fetchedAt={overview.fetchedAt}
            refreshing={overview.refreshing}
            error={overview.error}
            onRefresh={overview.refresh}
          />
        }
        actions={
          <Button variant="gradient" leadingIcon={<ExportIcon size={18} />}>
            Exportar
          </Button>
        }
      />

      {overview.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler a telemetria">
          {overview.error} Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row">
        {data
          ? data.stats.map((stat, index) => (
              <Reveal key={stat.id} index={index} className="flex flex-1">
                <StatCard {...stat} />
              </Reveal>
            ))
          : STAT_ACCENTS.map((accent) => (
              <StatCardSkeleton key={accent} accent={accent} />
            ))}
      </div>

      <Reveal delay={180}>
        <FilterBar value={filters} onChange={onFilterChange} />
      </Reveal>

      <div className="flex flex-col gap-6 lg:flex-row">
        {data ? (
          <>
            <Reveal delay={240} className="flex flex-1">
              <ExperienceHealthCard
                series={data.series}
                baseline={data.baseline}
                anomalyRange={data.anomalyRange}
                peakIndex={data.peakIndex}
                timeRange={filters.timeRange}
                onTimeRangeChange={(timeRange) => onFilterChange({ timeRange })}
              />
            </Reveal>
            <Reveal delay={320} className="flex w-full lg:w-auto">
              <IncidentsCard incidents={data.incidents} />
            </Reveal>
          </>
        ) : (
          <>
            <ExperienceHealthCardSkeleton />
            <IncidentsCardSkeleton />
          </>
        )}
      </div>
    </div>
  );
}

/** Converte o recorte da barra no formato que a leitura espera. */
function toQuery(filters: DashboardFilters): OverviewFilters {
  return {
    timeRange: filters.timeRange,
    device: filters.device,
    region: filters.region,
    appVersion: filters.appVersion,
  };
}

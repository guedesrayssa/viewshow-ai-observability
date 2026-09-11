/**
 * @file overview-view.tsx
 * Conteúdo da Visão Geral, alimentado integralmente pela projeção canônica de
 * dashboard. Indicadores, série e incidentes compartilham a mesma janela e a
 * mesma procedência.
 */

"use client";

import { useCallback, useState } from "react";

import {
  fetchOverview,
  formatErrorsPerMinute,
  type OverviewFilters,
} from "@/app/(painel)/visao-geral/overview-resource";
import { DataStatus } from "@/components/dashboard/data-status";
import {
  ExperienceHealthCard,
  ExperienceHealthCardSkeleton,
} from "@/components/dashboard/experience-health-card";
import {
  DEFAULT_DASHBOARD_FILTERS,
  FilterBar,
  type DashboardFilters,
} from "@/components/dashboard/filter-bar";
import {
  IncidentsCard,
  IncidentsCardSkeleton,
} from "@/components/dashboard/incidents-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/stat-card";
import { Unavailable } from "@/components/dashboard/unavailable";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExportIcon } from "@/components/ui/icons";
import { useResource } from "@/hooks/use-resource";
import type { StatAccent } from "@/lib/dashboard-data";

const REFRESH_MS = 30_000;
const STAT_ACCENTS: StatAccent[] = ["info", "warning", "critical"];

export function OverviewView() {
  const [filters, setFilters] = useState<DashboardFilters>(
    DEFAULT_DASHBOARD_FILTERS,
  );

  const overview = useResource(
    (revision) => fetchOverview(toQuery(filters), revision),
    [filters.timeRange],
    { refreshMs: REFRESH_MS },
  );

  const onFilterChange = useCallback((patch: Partial<DashboardFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const data = overview.data;
  const loading = overview.status === "loading";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão Geral"
        subtitle="Estado do ecossistema em tempo quase real"
        status={
          <DataStatus
            source={overview.source}
            availability={overview.availability}
            warnings={overview.warnings}
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

      {overview.status === "error" || overview.source === "indisponivel" ? (
        <Alert tone="critical" title="Não foi possível ler a Visão Geral">
          {overview.error ??
            overview.warnings[0]?.message ??
            "A projeção de dashboard não respondeu."}{" "}
          Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row">
        {data ? (
          data.stats.map((stat, index) => (
            <Reveal key={stat.id} index={index} className="flex flex-1">
              <StatCard {...stat} />
            </Reveal>
          ))
        ) : loading ? (
          STAT_ACCENTS.map((accent, index) => (
            <StatCardSkeleton key={index} accent={accent} />
          ))
        ) : (
          <Unavailable
            title="Indicadores indisponíveis"
            warning={overview.warnings[0]}
            className="flex-1"
          >
            A projeção de dashboard não retornou indicadores. Nenhum número é
            exibido para não afirmar um estado que não foi medido.
          </Unavailable>
        )}
      </div>

      <Reveal delay={180}>
        <FilterBar value={filters} onChange={onFilterChange} />
      </Reveal>

      <div className="flex flex-col gap-6 lg:flex-row">
        <Reveal delay={240} className="flex flex-1">
          {data ? (
            <ExperienceHealthCard
              series={data.series}
              baseline={data.baseline}
              anomalyRange={data.anomalyRange}
              peakIndex={data.peakIndex}
              metricLabel="Erros por minuto"
              description="Eventos de erro observados por minuto, por intervalo"
              formatValue={formatErrorsPerMinute}
              timeRange={filters.timeRange}
              onTimeRangeChange={(timeRange) => onFilterChange({ timeRange })}
            />
          ) : loading ? (
            <ExperienceHealthCardSkeleton />
          ) : (
            <Unavailable
              title="Saúde da experiência indisponível"
              warning={overview.warnings[0]}
              minHeight={340}
              className="flex-1"
            >
              A projeção de dashboard não retornou a série de saúde da
              experiência.
            </Unavailable>
          )}
        </Reveal>

        <Reveal delay={320} className="flex w-full lg:w-auto">
          {data ? (
            <IncidentsCard incidents={data.incidents} />
          ) : loading ? (
            <IncidentsCardSkeleton />
          ) : (
            <Unavailable
              title="Incidentes recentes indisponíveis"
              warning={overview.warnings[0]}
              minHeight={340}
              className="w-full lg:w-[360px]"
            >
              A projeção de dashboard não retornou os incidentes recentes.
            </Unavailable>
          )}
        </Reveal>
      </div>
    </div>
  );
}

function toQuery(filters: DashboardFilters): OverviewFilters {
  return {
    timeRange: filters.timeRange,
    device: filters.device,
    region: filters.region,
    appVersion: filters.appVersion,
  };
}

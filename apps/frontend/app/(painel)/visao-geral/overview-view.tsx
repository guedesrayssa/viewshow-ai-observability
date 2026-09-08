/**
 * @file overview-view.tsx
 * Conteúdo da Visão Geral.
 *
 * A tela junta duas leituras independentes:
 *
 * - `fetchSummary` (API operacional) — os três indicadores do topo e a lista
 *   de incidentes recentes. É a leitura principal: não depende da telemetria,
 *   então a tela mostra número real mesmo sem ela.
 * - `fetchOverview` (API de telemetria) — só a série de "saúde da experiência".
 *   Quando a telemetria não está publicada, o gráfico declara indisponível e o
 *   resto da tela segue.
 *
 * Cada mudança de período refaz a leitura da série, e a releitura automática
 * mantém as duas atualizadas enquanto a tela estiver aberta.
 */

"use client";

import { useCallback, useMemo, useState } from "react";

import {
  fetchOverview,
  formatRebufferRate,
  type OverviewFilters,
} from "@/app/(painel)/visao-geral/overview-resource";
import { fetchSummary } from "@/app/(painel)/visao-geral/summary-resource";
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
import { Unavailable } from "@/components/dashboard/unavailable";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExportIcon } from "@/components/ui/icons";
import { useResource } from "@/hooks/use-resource";
import type { StatAccent } from "@/lib/dashboard-data";

/** Releitura automática do hub, no ritmo do "tempo quase real" do produto. */
const REFRESH_MS = 30_000;

/** Faixas dos três indicadores, usadas também no espaço reservado. */
const STAT_ACCENTS: StatAccent[] = ["info", "warning", "critical"];

export function OverviewView() {
  const [filters, setFilters] = useState<DashboardFilters>(
    DEFAULT_DASHBOARD_FILTERS,
  );

  const summary = useResource((revision) => fetchSummary(revision), [], {
    refreshMs: REFRESH_MS,
  });

  const overview = useResource(
    (revision) => fetchOverview(toQuery(filters), revision),
    [filters.timeRange],
    { refreshMs: REFRESH_MS },
  );

  const onFilterChange = useCallback((patch: Partial<DashboardFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const summaryData = summary.data;
  const overviewData = overview.data;

  // A tela tem duas leituras independentes; a que ainda está carregando desenha
  // um espaço reservado, a que terminou sem dado desenha um estado de
  // indisponível. Sem essa distinção, uma leitura sem fonte ficaria presa no
  // espaço reservado para sempre.
  const summaryLoading = summary.status === "loading";

  // Atualizar tem que refazer as duas leituras: o botão fica no cabeçalho, que
  // fala pela tela inteira, não só pelo resumo.
  // `refresh` de cada leitura é estável (useCallback com deps vazias em
  // use-resource), então depender das duas funções basta.
  const refreshAll = useCallback(() => {
    summary.refresh();
    overview.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.refresh, overview.refresh]);

  // O cabeçalho combina as duas fontes. O resumo é a leitura principal e dá a
  // procedência; a telemetria, quando não está medida, rebaixa o selo de "ao
  // vivo" para "parcial" e entra na lista de avisos — em vez de o cabeçalho
  // anunciar dado ao vivo enquanto o gráfico está indisponível.
  const overviewSettled = overview.status !== "loading";
  const combinedAvailability =
    summary.availability === "measured" &&
    overviewSettled &&
    overview.availability !== "measured"
      ? "partial"
      : summary.availability;

  const combinedWarnings = useMemo(() => {
    const seen = new Set<string>();
    return [...summary.warnings, ...overview.warnings].filter((warning) => {
      if (seen.has(warning.code)) return false;
      seen.add(warning.code);
      return true;
    });
  }, [summary.warnings, overview.warnings]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão Geral"
        subtitle="Estado do ecossistema em tempo quase real"
        status={
          <DataStatus
            source={summary.source}
            availability={combinedAvailability}
            warnings={combinedWarnings}
            fetchedAt={summary.fetchedAt}
            refreshing={summary.refreshing || overview.refreshing}
            error={summary.error ?? overview.error}
            onRefresh={refreshAll}
          />
        }
        actions={
          <Button variant="gradient" leadingIcon={<ExportIcon size={18} />}>
            Exportar
          </Button>
        }
      />

      {summary.status === "error" || summary.source === "indisponivel" ? (
        <Alert tone="critical" title="Não foi possível ler o resumo de incidentes">
          {summary.error ??
            summary.warnings[0]?.message ??
            "A API de incidentes não respondeu a leitura do resumo."}{" "}
          Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row">
        {summaryData ? (
          summaryData.stats.map((stat, index) => (
            <Reveal key={stat.id} index={index} className="flex flex-1">
              <StatCard {...stat} />
            </Reveal>
          ))
        ) : summaryLoading ? (
          STAT_ACCENTS.map((accent, index) => (
            <StatCardSkeleton key={index} accent={accent} />
          ))
        ) : (
          <Unavailable
            title="Indicadores de incidentes indisponíveis"
            warning={summary.warnings[0]}
            className="flex-1"
          >
            A leitura do resumo veio da API de incidentes e não retornou. Nenhum
            número é exibido para não afirmar um estado que não foi medido.
          </Unavailable>
        )}
      </div>

      <Reveal delay={180}>
        <FilterBar value={filters} onChange={onFilterChange} />
      </Reveal>

      <div className="flex flex-col gap-6 lg:flex-row">
        <Reveal delay={240} className="flex flex-1">
          {overviewData ? (
            <ExperienceHealthCard
              series={overviewData.series}
              baseline={overviewData.baseline}
              anomalyRange={overviewData.anomalyRange}
              peakIndex={overviewData.peakIndex}
              metricLabel="Taxa de travamento"
              description="Tempo travado sobre tempo assistido, por intervalo"
              formatValue={formatRebufferRate}
              timeRange={filters.timeRange}
              onTimeRangeChange={(timeRange) => onFilterChange({ timeRange })}
            />
          ) : overview.status === "loading" ? (
            <ExperienceHealthCardSkeleton />
          ) : (
            <Unavailable
              title="Saúde da experiência indisponível"
              warning={overview.warnings[0]}
              minHeight={340}
              className="flex-1"
            >
              A série de travamento vem da telemetria de QoE, que não está
              publicada neste ambiente. Os indicadores acima seguem com dado
              real da API de incidentes.
            </Unavailable>
          )}
        </Reveal>

        <Reveal delay={320} className="flex w-full lg:w-auto">
          {summaryData ? (
            <IncidentsCard incidents={summaryData.incidents} />
          ) : summaryLoading ? (
            <IncidentsCardSkeleton />
          ) : (
            <Unavailable
              title="Incidentes recentes indisponíveis"
              warning={summary.warnings[0]}
              minHeight={340}
              className="w-full lg:w-[360px]"
            >
              A lista de incidentes recentes vem da API de incidentes, que não
              respondeu a leitura do resumo.
            </Unavailable>
          )}
        </Reveal>
      </div>
    </div>
  );
}

/**
 * Converte o recorte da barra no formato que a leitura da série espera.
 *
 * As três dimensões seguem no tipo, mas a leitura ainda não as envia: as rotas
 * que servem esta tela não as aceitam, e a barra as mostra desabilitadas.
 */
function toQuery(filters: DashboardFilters): OverviewFilters {
  return {
    timeRange: filters.timeRange,
    device: filters.device,
    region: filters.region,
    appVersion: filters.appVersion,
  };
}

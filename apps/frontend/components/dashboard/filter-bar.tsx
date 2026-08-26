/**
 * @file filter-bar.tsx
 * Barra de recorte da Visão Geral.
 *
 * Não guarda estado próprio: quem decide o recorte é a tela, porque é ela que
 * refaz a leitura da telemetria quando um filtro muda. Manter o valor aqui
 * dentro faria a barra e os dados discordarem entre si.
 */

"use client";

import { SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  APP_VERSION_OPTIONS,
  DEVICE_OPTIONS,
  REGION_OPTIONS,
  TIME_RANGE_OPTIONS,
} from "@/lib/dashboard-data";

export type DashboardFilters = {
  search: string;
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

/** Recorte inicial: o mesmo do protótipo de alta fidelidade. */
export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  search: "",
  timeRange: TIME_RANGE_OPTIONS[1].value,
  device: DEVICE_OPTIONS[0].value,
  region: REGION_OPTIONS[1].value,
  appVersion: APP_VERSION_OPTIONS[0].value,
};

export type FilterBarProps = {
  value: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
};

export function FilterBar({ value, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:flex-nowrap">
      <SearchInput
        placeholder="Buscar"
        aria-label="Buscar"
        value={value.search}
        onChange={(event) => onChange({ search: event.target.value })}
      />
      <Select
        aria-label="Período"
        value={value.timeRange}
        onValueChange={(value) => onChange({ timeRange: value })}
        options={TIME_RANGE_OPTIONS}
      />
      <Select
        aria-label="Dispositivo"
        value={value.device}
        onValueChange={(value) => onChange({ device: value })}
        options={DEVICE_OPTIONS}
      />
      <Select
        aria-label="Região"
        value={value.region}
        onValueChange={(value) => onChange({ region: value })}
        options={REGION_OPTIONS}
      />
      <Select
        aria-label="Versão do app"
        value={value.appVersion}
        onValueChange={(value) => onChange({ appVersion: value })}
        options={APP_VERSION_OPTIONS}
      />
    </div>
  );
}

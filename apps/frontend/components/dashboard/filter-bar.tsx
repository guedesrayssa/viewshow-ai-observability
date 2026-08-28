/**
 * @file filter-bar.tsx
 * Barra de recorte da Visão Geral.
 *
 * Não guarda estado próprio: quem decide o recorte é a tela, porque é ela que
 * refaz a leitura da telemetria quando um filtro muda. Manter o valor aqui
 * dentro faria a barra e os dados discordarem entre si.
 *
 * Só o período está ligado. As três dimensões continuam na barra, desabilitadas
 * e com o motivo escrito ao lado: as rotas que servem os indicadores desta tela
 * recortam por janela e não por dimensão, e um controle que aceita escolha sem
 * mudar nada na tela é pior do que um controle visivelmente indisponível. Elas
 * voltam a funcionar quando a origem publicar as combinações — sem mexer nesta
 * barra.
 *
 * O campo de busca saiu pelo mesmo motivo, e não volta como controle
 * desabilitado: busca por texto não é uma dimensão que a origem possa passar a
 * suportar, é outro endpoint. A busca por título existe em Incidentes, onde a
 * lista está na memória do navegador e pode de fato ser filtrada.
 */

"use client";

import { Select } from "@/components/ui/select";
import {
  APP_VERSION_OPTIONS,
  DEVICE_OPTIONS,
  REGION_OPTIONS,
  TIME_RANGE_OPTIONS,
} from "@/lib/dashboard-data";

export type DashboardFilters = {
  timeRange: string;
  device: string;
  region: string;
  appVersion: string;
};

/** Recorte inicial: o mesmo do protótipo de alta fidelidade. */
export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  timeRange: TIME_RANGE_OPTIONS[1].value,
  device: DEVICE_OPTIONS[0].value,
  region: REGION_OPTIONS[1].value,
  appVersion: APP_VERSION_OPTIONS[0].value,
};

export type FilterBarProps = {
  value: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
  /**
   * Dimensões que a origem sustenta neste momento. Vazio — o padrão — deixa as
   * três desabilitadas.
   */
  supportedDimensions?: readonly ("device" | "region" | "appVersion")[];
};

export function FilterBar({
  value,
  onChange,
  supportedDimensions = [],
}: FilterBarProps) {
  const supports = (dimension: "device" | "region" | "appVersion") =>
    supportedDimensions.includes(dimension);

  const allDisabled = supportedDimensions.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:flex-nowrap">
        <Select
          aria-label="Período"
          value={value.timeRange}
          onValueChange={(timeRange) => onChange({ timeRange })}
          options={TIME_RANGE_OPTIONS}
        />
        <Select
          aria-label="Dispositivo"
          value={value.device}
          onValueChange={(device) => onChange({ device })}
          options={DEVICE_OPTIONS}
          disabled={!supports("device")}
        />
        <Select
          aria-label="Região"
          value={value.region}
          onValueChange={(region) => onChange({ region })}
          options={REGION_OPTIONS}
          disabled={!supports("region")}
        />
        <Select
          aria-label="Versão do app"
          value={value.appVersion}
          onValueChange={(appVersion) => onChange({ appVersion })}
          options={APP_VERSION_OPTIONS}
          disabled={!supports("appVersion")}
        />
      </div>

      {allDisabled ? (
        <p className="text-caption text-ink-subtle">
          A origem atual recorta por período. Dispositivo, região e versão do app
          voltam quando a telemetria publicar essas segmentações.
        </p>
      ) : null}
    </div>
  );
}

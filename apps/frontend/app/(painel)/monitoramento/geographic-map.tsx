/**
 * @file geographic-map.tsx
 * Cartão "Concentração geográfica".
 *
 * Mostra onde a instabilidade se concentra no país, conforme a seção 5.6 do
 * entendimento de UX. O desenho é uma silhueta simplificada do Brasil
 * dividida nas cinco regiões, escrita à mão em SVG: o projeto não tem
 * biblioteca de mapas nem base cartográfica, e a leitura pretendida aqui é
 * comparativa, não geográfica.
 *
 * A escala de cor tem cinco níveis, mas nunca comunica sozinha: cada região
 * aparece abaixo do mapa com nome e valor, e o mapa descreve a distribuição
 * inteira para leitores de tela.
 */

"use client";

import { useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

import {
  MAP_METRICS,
  REGIONS,
  type MapMetric,
} from "@/app/(painel)/monitoramento/telemetry-data";

/**
 * Níveis da escala, do menor para o maior. O tom do selo acompanha o
 * preenchimento do mapa para que as duas leituras não se contradigam.
 */
const INTENSITY_LEVELS: { fillClass: string; tone: BadgeTone; label: string }[] = [
  { fillClass: "fill-brand-orange/20", tone: "neutral", label: "muito baixa" },
  { fillClass: "fill-brand-orange/50", tone: "neutral", label: "baixa" },
  { fillClass: "fill-brand-orange", tone: "warning", label: "moderada" },
  { fillClass: "fill-critical", tone: "critical", label: "alta" },
  { fillClass: "fill-brand-red-deep", tone: "critical", label: "muito alta" },
];

/** Posição da região na escala, pela razão com o maior valor observado. */
function toLevel(value: number, max: number): number {
  if (max <= 0) return 0;

  const ratio = value / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  if (ratio > 0.1) return 1;
  return 0;
}

export function GeographicMap() {
  const [metric, setMetric] = useState<MapMetric>("instabilidade");

  const config = MAP_METRICS[metric];
  const max = Math.max(...REGIONS.map((region) => region.values[metric]));

  const ranked = [...REGIONS]
    .map((region) => {
      const value = region.values[metric];
      const level = INTENSITY_LEVELS[toLevel(value, max)];

      return { ...region, value, level };
    })
    .sort((a, b) => b.value - a.value);

  const summary = ranked
    .map((region) => `${region.name}, ${config.format(region.value)}, ${region.level.label}`)
    .join("; ");

  return (
    <Card padding="lg" className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>Concentração geográfica</CardTitle>
          <CardDescription className="mt-1">{config.hint}</CardDescription>
        </div>

        <Select
          aria-label="Métrica da concentração geográfica"
          value={metric}
          onChange={(event) => setMetric(event.target.value as MapMetric)}
        >
          {(Object.keys(MAP_METRICS) as MapMetric[]).map((key) => (
            <option key={key} value={key}>
              Métrica: {MAP_METRICS[key].label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-1 items-center justify-center py-8">
        <svg
          viewBox="0 0 100 108"
          className="h-auto w-full max-w-xs"
          role="img"
          aria-label={`Distribuição de ${config.label} por região do Brasil: ${summary}.`}
        >
          {ranked.map((region) => (
            <path
              key={region.id}
              d={region.path}
              className={`${region.level.fillClass} stroke-surface`}
              strokeWidth={0.8}
              strokeLinejoin="round"
            >
              <title>{`${region.name}: ${config.format(region.value)}`}</title>
            </path>
          ))}
        </svg>
      </div>

      <ul className="flex flex-wrap justify-center gap-2">
        {ranked.map((region) => (
          <li key={region.id}>
            <Badge tone={region.level.tone} withDot className="uppercase">
              {region.name} · {config.format(region.value)}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

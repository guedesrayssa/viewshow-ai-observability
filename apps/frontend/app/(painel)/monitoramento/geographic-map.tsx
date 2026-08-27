/**
 * @file geographic-map.tsx
 * Cartão "Concentração geográfica".
 *
 * Mostra onde a instabilidade se concentra no país, conforme a seção 5.6 do
 * entendimento de UX. O recorte é a unidade federativa: uma degradação de
 * player raramente respeita a divisão em grandes regiões, e ver Pernambuco
 * aceso ao lado da Bahia diz mais do que ver "Nordeste" aceso inteiro.
 *
 * O contorno vem de `br-states-geometry.ts`, gerado dos limites do IBGE. A
 * escala de cor tem cinco níveis e nunca comunica sozinha: o estado sob o
 * ponteiro abre um detalhe com nome, região, valor e sessões, o resumo por
 * região fica abaixo em texto, e o mapa inteiro é descrito para leitores de
 * tela.
 */

"use client";

import { useState } from "react";

import {
  MAP_METRICS,
  MAP_VIEW_BOX,
  summarizeByRegion,
  type MapMetric,
  type StateTelemetry,
} from "@/app/(painel)/monitoramento/telemetry-data";
import { Reveal } from "@/components/motion/reveal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";

/**
 * Níveis da escala, do menor para o maior. O tom do selo acompanha o
 * preenchimento do mapa para que as duas leituras não se contradigam.
 */
const INTENSITY_LEVELS: { fillClass: string; tone: BadgeTone; label: string }[] = [
  { fillClass: "fill-brand-orange/15", tone: "neutral", label: "muito baixa" },
  { fillClass: "fill-brand-orange/40", tone: "neutral", label: "baixa" },
  { fillClass: "fill-brand-orange", tone: "warning", label: "moderada" },
  { fillClass: "fill-critical", tone: "critical", label: "alta" },
  { fillClass: "fill-brand-red-deep", tone: "critical", label: "muito alta" },
];

/** Posição do estado na escala, pela razão com o maior valor observado. */
function toLevel(value: number, max: number): number {
  if (max <= 0) return 0;

  const ratio = value / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  if (ratio > 0.1) return 1;
  return 0;
}

type RankedState = StateTelemetry & {
  level: (typeof INTENSITY_LEVELS)[number];
  value: number;
};

export type GeographicMapProps = {
  /** Estados lidos da telemetria. Sem eles, o cartão mostra a espera. */
  states?: StateTelemetry[];
};

export function GeographicMap({ states }: GeographicMapProps) {
  const [metric, setMetric] = useState<MapMetric>("instabilidade");
  const [hovered, setHovered] = useState<RankedState | null>(null);

  const config = MAP_METRICS[metric];
  const source = states ?? [];
  const max = source.length
    ? Math.max(...source.map((state) => state.values[metric]))
    : 0;

  const ranked: RankedState[] = source.map((state) => {
    const value = state.values[metric];
    return { ...state, value, level: INTENSITY_LEVELS[toLevel(value, max)] };
  });

  const worst = [...ranked].sort((a, b) => b.value - a.value).slice(0, 5);
  const regions = summarizeByRegion(source, metric);

  const summary = [...ranked]
    .sort((a, b) => b.value - a.value)
    .map(
      (state) =>
        `${state.name}, ${config.format(state.value)}, ${state.level.label}`,
    )
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
          onValueChange={(value) => setMetric(value as MapMetric)}
          options={(Object.keys(MAP_METRICS) as MapMetric[]).map((key) => ({
            value: key,
            label: `Métrica: ${MAP_METRICS[key].label}`,
          }))}
        />
      </div>

      {ranked.length === 0 ? (
        <Skeleton className="my-6 h-72 w-full" />
      ) : (
        <div className="flex flex-1 flex-col items-center gap-4 py-5 sm:flex-row sm:items-start">
          <svg
            viewBox={MAP_VIEW_BOX}
            className="h-auto w-full max-w-[24rem] flex-1"
            role="img"
            aria-label={`Distribuição de ${config.label} por unidade federativa: ${summary}.`}
            onMouseLeave={() => setHovered(null)}
          >
            {ranked.map((state, index) => {
              const active = hovered?.id === state.id;

              return (
                <path
                  key={state.id}
                  d={state.path}
                  tabIndex={0}
                  role="button"
                  aria-label={`${state.name}: ${config.format(state.value)}, ${state.level.label}`}
                  onMouseEnter={() => setHovered(state)}
                  onFocus={() => setHovered(state)}
                  onBlur={() => setHovered(null)}
                  className={cn(
                    state.level.fillClass,
                    // A divisa é um fio: ela só precisa dizer onde um estado
                    // termina e o outro começa. Mais grossa que isso, ela come
                    // a área dos estados pequenos do Sudeste e do Nordeste e
                    // vira o desenho mais forte do cartão.
                    "stroke-surface",
                    // A cor muda com transição para que a troca de métrica seja
                    // lida como o mesmo mapa em outra escala, e não como outro
                    // mapa.
                    "animate-fade-in cursor-pointer transition-[fill,opacity] duration-300",
                    // Sob o ponteiro, o realce vem de os vizinhos recuarem —
                    // a mesma linguagem do gráfico de barras —, e não de o
                    // estado clarear.
                    hovered !== null && !active && "opacity-40",
                  )}
                  style={{ animationDelay: `${index * 22}ms` }}
                  strokeWidth={0.75}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* O contorno do estado em foco é desenhado por último, fora do
                laço: como borda do próprio caminho, ele ficaria pela metade,
                encoberto pelos estados vizinhos pintados depois dele. */}
            {hovered ? (
              <path
                d={hovered.path}
                aria-hidden="true"
                className="pointer-events-none fill-none stroke-ink"
                strokeWidth={1.25}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {/* Detalhe do estado sob o ponteiro. Fica ao lado do mapa, e não em
              um balão que persegue o cursor: sobre estados pequenos como os do
              Nordeste, o balão cobriria justamente os vizinhos que interessa
              comparar. Sem ponteiro sobre o mapa, mostra o estado mais afetado
              — a leitura que a tela responderia primeiro de qualquer jeito. */}
          <MapDetail
            state={hovered ?? worst[0]}
            format={config.format}
            metricLabel={config.label}
            following={hovered !== null}
          />
        </div>
      )}

      {ranked.length > 0 ? (
        <>
          <p className="text-caption font-medium text-ink">Estados mais afetados</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {worst.map((state, index) => (
              <Reveal as="li" key={state.id} index={index} variant="scale">
                <Badge tone={state.level.tone} withDot>
                  {state.name} · {config.format(state.value)}
                </Badge>
              </Reveal>
            ))}
          </ul>

          <p className="mt-4 text-caption font-medium text-ink">Por região</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {regions.map((region) => (
              <li
                key={region.region}
                className="flex items-center gap-3 text-caption"
              >
                <span className="w-24 shrink-0 text-ink-muted">
                  {region.region}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-line-subtle">
                  <span
                    key={region.value}
                    className="track-grow block h-full rounded-pill bg-brand-orange"
                    style={{
                      width: `${max === 0 ? 0 : (region.value / max) * 100}%`,
                    }}
                  />
                </span>
                <span className="w-14 shrink-0 text-right font-medium text-ink">
                  {config.format(region.value)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/** Detalhe do estado em foco, ao lado do mapa. */
function MapDetail({
  state,
  format,
  metricLabel,
  following,
}: {
  state: RankedState | undefined;
  format: (value: number) => string;
  metricLabel: string;
  following: boolean;
}) {
  if (!state) return null;

  return (
    <div
      // O bloco troca de conteúdo conforme o ponteiro anda pelo mapa, então
      // anunciá-lo a cada mudança seria ruído: quem usa leitor de tela lê o
      // valor no próprio estado, que já tem rótulo.
      aria-hidden="true"
      className="w-full shrink-0 rounded-card border border-line bg-surface-muted p-3 sm:w-48"
    >
      <p className="text-micro uppercase tracking-wide text-ink-subtle">
        {following ? "Sob o ponteiro" : "Mais afetado"}
      </p>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="text-label font-semibold text-ink">{state.name}</p>
        <span className="text-micro uppercase text-ink-subtle">{state.id}</span>
      </div>
      <p className="text-micro text-ink-subtle">{state.region}</p>

      <p className="mt-2 text-h3 text-ink">{format(state.value)}</p>
      <p className="text-micro text-ink-muted">{metricLabel}</p>

      <dl className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-micro">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Sessões</dt>
          <dd className="font-medium text-ink">
            {formatCompact(state.sessions * 1000)}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Fonte principal</dt>
          <dd className="font-medium text-ink">{state.topSource}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Intensidade</dt>
          <dd className="font-medium text-ink">{state.level.label}</dd>
        </div>
      </dl>
    </div>
  );
}

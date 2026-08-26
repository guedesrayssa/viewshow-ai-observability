/**
 * @file processing-flow-chart.tsx
 * Gráfico "Fluxo de processamento".
 *
 * Mostra a evolução da métrica escolhida nos filtros técnicos, separada nas
 * etapas de ingestão e de processamento, com a linha tracejada da meta
 * operacional e o destaque do pico, conforme a seção 5.6 do entendimento de
 * UX. É desenhado em SVG porque o projeto não tem biblioteca de gráficos.
 *
 * O traçado usa um `viewBox` de 0 a 100 nos dois eixos e
 * `preserveAspectRatio="none"`, de modo que a posição de cada ponto é
 * diretamente a sua porcentagem. A espessura das linhas é preservada por
 * `vector-effect="non-scaling-stroke"`, e os textos ficam em uma camada HTML
 * sobre o desenho para não esticarem junto com ele.
 *
 * As duas séries são escritas da esquerda para a direita a cada leitura, na
 * ordem do pipeline: primeiro a ingestão, que é a entrada, e depois o
 * processamento, que é onde a degradação aparece.
 */

"use client";

import { useState } from "react";

import { CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

import {
  buildFlowChart,
  FLOW_METRICS,
  FLOW_WINDOW_LABELS,
  type FlowMetric,
  type FlowWindow,
  type TelemetrySource,
} from "@/app/(painel)/monitoramento/telemetry-data";

/** Faixa reservada no topo do desenho para a anotação do pico, em `%`. */
const TOP_INSET = 12;

/** Duração do traço, casada com `--animate-draw`. */
const DRAW_MS = 1150;

const LEGEND = [
  { label: "Processamento", dotClass: "bg-critical" },
  { label: "Ingestão", dotClass: "bg-brand-blue-light" },
  { label: "Meta", dotClass: "bg-warning" },
];

/** Converte o valor da métrica na posição vertical, em `%` do desenho. */
function toY(value: number, axisMax: number): number {
  const ratio = Math.min(1, Math.max(0, value / axisMax));
  return TOP_INSET + (1 - ratio) * (100 - TOP_INSET);
}

/** Converte o índice do ponto na posição horizontal, em `%` do desenho. */
function toX(index: number, total: number): number {
  return total <= 1 ? 0 : (index / (total - 1)) * 100;
}

function toPoints(values: number[], axisMax: number): string {
  return values
    .map((value, index) => `${toX(index, values.length)},${toY(value, axisMax)}`)
    .join(" ");
}

/** Área sob a curva de processamento, fechada na base do gráfico. */
function toAreaPath(values: number[], axisMax: number): string {
  const segments = values.map(
    (value, index) => `L${toX(index, values.length)},${toY(value, axisMax)}`,
  );

  return ["M0,100", ...segments, "L100,100", "Z"].join(" ");
}

/** Mantém o rótulo dentro do gráfico nas duas pontas do eixo horizontal. */
function labelShift(index: number, total: number): string {
  if (index === 0) return "translateX(0)";
  if (index === total - 1) return "translateX(-100%)";
  return "translateX(-50%)";
}

export type ProcessingFlowChartProps = {
  sources: TelemetrySource[];
  metric: FlowMetric;
};

export function ProcessingFlowChart({ sources, metric }: ProcessingFlowChartProps) {
  const [window, setWindow] = useState<FlowWindow>("30");

  const config = FLOW_METRICS[metric];
  const data = buildFlowChart(sources, metric, window);

  if (!data) return null;

  const { axisMax, axisStep, target } = config;
  const ticks = Array.from(
    { length: Math.floor(axisMax / axisStep) + 1 },
    (_, index) => index * axisStep,
  );

  const peakValue = data.processing[data.peakIndex];
  const peakX = toX(data.peakIndex, data.processing.length);
  const peakY = toY(peakValue, axisMax);
  const targetY = toY(target, axisMax);
  const lastIndex = data.processing.length - 1;

  /* Um rótulo a cada dois pontos quando a série é longa, para não empilhar. */
  const labelStep = data.times.length > 8 ? 2 : 1;

  return (
    <section aria-labelledby="fluxo-processamento">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle id="fluxo-processamento">Fluxo de processamento</CardTitle>
          <CardDescription className="mt-1">{config.description}</CardDescription>
        </div>

        <Select
          aria-label="Janela do gráfico"
          value={window}
          onValueChange={(value) => setWindow(value as FlowWindow)}
          options={(Object.keys(FLOW_WINDOW_LABELS) as FlowWindow[]).map((key) => ({
            value: key,
            label: FLOW_WINDOW_LABELS[key],
          }))}
        />
      </div>

      <div className="mt-8 flex gap-3">
        {/* Eixo vertical, alinhado às linhas de grade pela mesma escala. */}
        <div className="relative h-56 w-20 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-caption text-ink-subtle"
              style={{ top: `${toY(tick, axisMax)}%` }}
            >
              {tick === 0 ? "0" : config.format(tick)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-56">
            <svg
              key={data.processing.join(",")}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="h-full w-full"
              role="img"
              aria-label={`${config.label} por etapa. Processamento parte de ${config.format(
                data.processing[0],
              )}, atinge o pico de ${config.format(peakValue)} às ${
                data.times[data.peakIndex]
              } e termina em ${config.format(
                data.processing[lastIndex],
              )}. Ingestão parte de ${config.format(
                data.ingestion[0],
              )} e termina em ${config.format(
                data.ingestion[lastIndex],
              )}. A meta operacional é ${config.format(target)}.`}
            >
              {ticks.map((tick) => (
                <line
                  key={tick}
                  x1="0"
                  x2="100"
                  y1={toY(tick, axisMax)}
                  y2={toY(tick, axisMax)}
                  vectorEffect="non-scaling-stroke"
                  className="stroke-line-subtle"
                  strokeWidth={1}
                />
              ))}

              <line
                x1="0"
                x2="100"
                y1={targetY}
                y2={targetY}
                vectorEffect="non-scaling-stroke"
                className="stroke-warning"
                strokeWidth={1}
                strokeDasharray="4 4"
              />

              <path
                d={toAreaPath(data.processing, axisMax)}
                className="animate-fade-in fill-critical/10"
                style={{ animationDelay: `${DRAW_MS * 0.35}ms` }}
              />

              <polyline
                points={toPoints(data.ingestion, axisMax)}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className="animate-draw stroke-brand-blue-light"
                strokeWidth={2}
                strokeLinejoin="round"
                pathLength={1}
                style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
              />

              <polyline
                points={toPoints(data.processing, axisMax)}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className="animate-draw stroke-critical"
                strokeWidth={2}
                strokeLinejoin="round"
                pathLength={1}
                style={{
                  strokeDasharray: 1,
                  strokeDashoffset: 1,
                  animationDelay: "160ms",
                }}
              />
            </svg>

            {/* Camada HTML: os textos ficam fora da escala distorcida do SVG. */}
            <div className="pointer-events-none absolute inset-0">
              <span
                className="absolute right-0 pb-1 text-caption text-warning-strong"
                style={{ top: `${targetY}%`, transform: "translateY(-100%)" }}
              >
                limite da meta
              </span>

              <span
                aria-hidden="true"
                className="absolute h-2.5 w-2.5 animate-pop rounded-pill bg-critical ring-2 ring-surface"
                style={{
                  left: `${peakX}%`,
                  top: `${peakY}%`,
                  transform: "translate(-50%, -50%)",
                  animationDelay: `${DRAW_MS * 0.85}ms`,
                }}
              />

              <span
                className="absolute pb-2 text-caption font-semibold text-critical-strong"
                style={{
                  left: `${peakX}%`,
                  top: `${peakY}%`,
                  transform: `${labelShift(data.peakIndex, data.processing.length)} translateY(-100%)`,
                }}
              >
                {config.format(peakValue)}
              </span>
            </div>
          </div>

          <div className="relative mt-2 h-5">
            {data.times.map((time, index) =>
              index % labelStep === 0 || index === lastIndex ? (
                <span
                  key={time}
                  className="absolute text-caption text-ink-brand"
                  style={{
                    left: `${toX(index, data.times.length)}%`,
                    transform: labelShift(index, data.times.length),
                  }}
                >
                  {time}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-wrap items-center gap-5">
        {LEGEND.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-1.5 text-caption text-ink-muted"
          >
            <span
              aria-hidden="true"
              className={cn("h-2.5 w-2.5 rounded-pill", item.dotClass)}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * @file kpi-card.tsx
 * Cartão de indicador do pipeline de telemetria.
 *
 * Reproduz os quatro cartões do topo da tela de Monitoramento: rótulo, valor
 * em destaque e uma nota curta que qualifica o número. A nota é obrigatória
 * porque é ela que dá o estado em texto, sem depender da faixa colorida do
 * cartão.
 *
 * O valor conta até o número lido. Em um painel de pipeline, que se atualiza
 * sozinho, é essa contagem que mostra a fila subindo ou a latência cedendo.
 */

"use client";

import { AnimatedNumber } from "@/components/motion/animated-number";
import { Card, type CardAccent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/** Significado do indicador, que define a faixa e a cor do rótulo. */
export type KpiTone = "info" | "warning" | "critical";

const TONE_CLASSES: Record<KpiTone, { accent: CardAccent; labelClass: string }> = {
  info: { accent: "info", labelClass: "text-ink-brand" },
  warning: { accent: "warning", labelClass: "text-warning-strong" },
  critical: { accent: "critical", labelClass: "text-critical-strong" },
};

/** Leitura da nota: se o número está dentro do esperado ou não. */
export type KpiNoteTone = "neutral" | "success" | "warning" | "critical";

const NOTE_CLASSES: Record<KpiNoteTone, string> = {
  neutral: "text-ink-muted",
  success: "text-success-strong",
  warning: "text-warning-strong",
  critical: "text-critical-strong",
};

export type KpiCardProps = {
  label: string;
  /** Valor medido. A formatação fica na função `format`. */
  value: number;
  /** Escreve o valor, incluindo unidade. */
  format: (value: number) => string;
  note: string;
  tone: KpiTone;
  noteTone: KpiNoteTone;
};

export function KpiCard({
  label,
  value,
  format,
  note,
  tone,
  noteTone,
}: KpiCardProps) {
  const meta = TONE_CLASSES[tone];

  return (
    <Card accent={meta.accent} padding="md">
      <p className={cn("text-caption font-medium", meta.labelClass)}>{label}</p>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="text-h2 text-ink">
          <AnimatedNumber value={value} format={format} />
        </strong>
        <span className={cn("text-caption", NOTE_CLASSES[noteTone])}>{note}</span>
      </div>
    </Card>
  );
}

/** Espaço reservado do indicador, enquanto a leitura não termina. */
export function KpiCardSkeleton({ tone }: { tone: KpiTone }) {
  return (
    <Card accent={TONE_CLASSES[tone].accent} padding="md">
      <Skeleton className="h-3 w-32" />
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>
    </Card>
  );
}

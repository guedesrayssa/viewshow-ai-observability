/**
 * @file stat-card.tsx
 * Cartão de indicador da Visão Geral.
 *
 * O valor conta até o número lido, e não aparece pronto: em um painel que se
 * atualiza sozinho, é a contagem que diferencia o dado que acabou de chegar do
 * que já estava na tela. A comparação com a linha de base fica sempre em
 * texto, ao lado do número.
 */

"use client";

import { AnimatedNumber } from "@/components/motion/animated-number";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { StatAccent, StatCardData } from "@/lib/dashboard-data";
import { formatCompact, formatInteger } from "@/lib/format";

const DELTA_CLASSES: Record<StatAccent, string> = {
  critical: "text-critical-strong",
  warning: "text-warning-strong",
  info: "text-ink-muted",
};

export function StatCard({
  label,
  value,
  format,
  unit,
  delta,
  accent,
  deltaTone,
}: StatCardData) {
  return (
    <Card accent={accent} className="flex-1">
      <CardDescription>{label}</CardDescription>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <CardTitle className="text-h2">
          <AnimatedNumber
            value={value}
            format={format === "compact" ? formatCompact : formatInteger}
            suffix={unit}
          />
        </CardTitle>
        <span
          className={cn(
            "text-caption font-medium",
            deltaTone === "accent" ? DELTA_CLASSES[accent] : "text-ink-muted",
          )}
        >
          {delta}
        </span>
      </div>
    </Card>
  );
}

/** Espaço reservado do cartão, enquanto a leitura não termina. */
export function StatCardSkeleton({ accent }: { accent: StatAccent }) {
  return (
    <Card accent={accent} className="flex-1">
      <Skeleton className="h-3 w-24" />
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-20" />
      </div>
    </Card>
  );
}

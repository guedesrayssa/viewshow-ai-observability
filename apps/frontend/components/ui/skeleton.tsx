/**
 * @file skeleton.tsx
 * Espaço reservado enquanto o dado não chegou.
 *
 * Ocupa exatamente o tamanho do conteúdo que virá, para que a chegada da
 * telemetria não empurre a página. O brilho que atravessa a peça indica que
 * algo está em andamento; um bloco parado seria lido como conteúdo vazio.
 */

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/**
 * Bloco de espera.
 *
 * @example
 * <Skeleton className="h-8 w-32" />
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("skeleton", className)}
      {...props}
    />
  );
}

/**
 * Linhas de texto em espera.
 *
 * @example
 * <SkeletonText lines={3} />
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className="h-3.5"
          // A última linha mais curta imita o fim de um parágrafo e evita o
          // bloco retangular perfeito, que não se parece com texto.
          style={{ width: index === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}

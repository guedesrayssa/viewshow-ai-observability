/**
 * @file route-redirect.tsx
 * Redireciona endereços antigos preservando a query string.
 *
 * `/evidencias?incidente=X` e `/eventos?incidente=X` viraram abas do detalhe
 * do incidente. Links salvos e favoritos continuam funcionando: a rota antiga
 * troca o endereço, sem entrar no histórico, e leva os parâmetros junto.
 * Como o painel é exportado como HTML estático, o redirecionamento acontece
 * no navegador.
 */

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { Skeleton } from "@/components/ui/skeleton";

export function RouteRedirect({
  resolve,
}: {
  /** Recebe a query atual e devolve o novo endereço completo. */
  resolve: (params: URLSearchParams) => string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    router.replace(resolve(new URLSearchParams(searchParams.toString())));
  }, [resolve, router, searchParams]);

  return <Skeleton className="h-96 w-full" aria-label="Redirecionando" />;
}

/**
 * @file panel-guard.tsx
 * Barreira de sessão das telas autenticadas.
 *
 * O painel é um export estático (`output: "export"` em next.config.ts, sem
 * servidor) — não há middleware nem rota de servidor capaz de barrar a
 * requisição antes de a casca do painel ser servida. A checagem só pode
 * acontecer depois de montar, no cliente, reaproveitando a sessão que
 * `AccountProvider` já busca (sem repetir o fetch a `/auth/session`).
 *
 * Isso não substitui a proteção de verdade: os dados continuam vindo só com
 * sessão válida, porque a API já exige cookie e responde 401 sem ele. O que
 * isto resolve é a casca do painel (menu, topo, avatar) aparecer para quem
 * não está logado — o problema que existia antes.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAccount } from "@/components/account/account-provider";
import { isDemoModeActive } from "@/lib/auth";

export function PanelGuard({ children }: { children: ReactNode }) {
  const { sessionStatus } = useAccount();
  const router = useRouter();
  const demoMode = isDemoModeActive();

  useEffect(() => {
    if (sessionStatus === "unauthenticated" && !demoMode) router.replace("/login");
  }, [sessionStatus, demoMode, router]);

  if (demoMode || sessionStatus === "authenticated") return <>{children}</>;

  // "checking" e "unauthenticated" (redirecionando) não desenham nada: a
  // alternativa seria mostrar a casca por um instante para quem nem sessão
  // tem, que é exatamente o que este componente existe para evitar.
  return null;
}

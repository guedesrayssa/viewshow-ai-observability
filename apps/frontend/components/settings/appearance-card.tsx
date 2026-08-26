/**
 * @file appearance-card.tsx
 * Preferência de aparência da conta.
 *
 * A troca rápida fica na barra superior, ao alcance de qualquer tela. Aqui
 * mora a escolha completa, incluindo acompanhar o sistema operacional — que é
 * a opção certa para quem alterna entre dia e noite no mesmo turno.
 */

"use client";

import { useTheme } from "@/components/theme/theme-provider";
import { ThemeChoice } from "@/components/theme/theme-toggle";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

/** Explica, em uma linha, o que a escolha atual significa na prática. */
const SUMMARIES = {
  light: "O painel fica sempre no tema claro.",
  dark: "O painel fica sempre no tema escuro, em azul-noite.",
  system: "O painel acompanha o tema do sistema operacional.",
} as const;

export function AppearanceCard() {
  const { preference, theme } = useTheme();

  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Aparência</CardTitle>
      <CardDescription>
        Vale para este navegador e é aplicada na hora
      </CardDescription>

      <div className="mt-5 flex flex-1 flex-col justify-between gap-5">
        <ThemeChoice className="self-start" />

        <p className="text-caption text-ink-muted">
          {SUMMARIES[preference]}
          {preference === "system"
            ? ` Agora está em ${theme === "dark" ? "escuro" : "claro"}.`
            : ""}
        </p>
      </div>
    </Card>
  );
}

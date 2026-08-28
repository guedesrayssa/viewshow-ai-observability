/**
 * @file theme-toggle.tsx
 * Alternância de aparência.
 *
 * `ThemeToggle` é o botão do topo: uma ação só, que troca entre claro e
 * escuro. `ThemeChoice` é o controle completo das Configurações, onde cabe a
 * terceira opção — acompanhar o sistema.
 */

"use client";

import { useTheme } from "@/components/theme/theme-provider";
import { DisplayIcon, MoonIcon, SunIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { ThemePreference } from "@/lib/theme";

/**
 * Botão de troca rápida de tema.
 *
 * O rótulo anuncia a ação, não o estado: quem está no claro lê "Ativar tema
 * escuro". O ícone mostra o destino da ação pelo mesmo motivo.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const goingDark = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={goingDark ? "Ativar tema escuro" : "Ativar tema claro"}
      title={goingDark ? "Ativar tema escuro" : "Ativar tema claro"}
      className={cn("group relative overflow-hidden", className)}
    >
      {/* Os dois ícones ficam empilhados e giram na troca, para que a mudança
          de tema tenha a mesma continuidade visual da interface atrás dela. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-all duration-300",
          goingDark
            ? "rotate-0 opacity-100"
            : "-rotate-90 opacity-0",
        )}
      >
        <MoonIcon size={18} />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-all duration-300",
          goingDark ? "rotate-90 opacity-0" : "rotate-0 opacity-100",
        )}
      >
        <SunIcon size={18} />
      </span>
    </button>
  );
}

const CHOICES: { value: ThemePreference; label: string; icon: typeof SunIcon }[] =
  [
    { value: "light", label: "Claro", icon: SunIcon },
    { value: "dark", label: "Escuro", icon: MoonIcon },
    { value: "system", label: "Sistema", icon: DisplayIcon },
  ];

/**
 * Escolha de aparência com as três opções.
 *
 * @example
 * <ThemeChoice />
 */
export function ThemeChoice({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Aparência"
      className={cn(
        "inline-flex gap-1 rounded-pill border border-line bg-canvas p-1",
        className,
      )}
    >
      {CHOICES.map((choice) => {
        const active = preference === choice.value;
        const Icon = choice.icon;

        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setPreference(choice.value)}
            className={cn(
              "focus-ring flex items-center gap-2 rounded-pill px-3.5 py-2 text-body-sm font-medium",
              "transition-colors duration-200",
              active
                ? "bg-surface text-ink shadow-card"
                : "text-ink-muted hover:text-ink",
            )}
          >
            <Icon size={16} />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

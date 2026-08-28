/**
 * @file theme-provider.tsx
 * Estado do tema claro e escuro.
 *
 * A preferência vem da loja persistida (`lib/theme.ts`) e o gosto do sistema
 * operacional vem de uma media query. Nenhum dos dois é estado do React: os
 * dois são lidos direto da origem, e o único efeito aqui escreve o resultado
 * no documento.
 *
 * O tema inicial já chega resolvido pelo script do `app/layout.tsx`, então
 * este componente só corrige — nunca aplica pela primeira vez.
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useMediaQuery } from "@/hooks/use-media-query";
import {
  resolveTheme,
  themePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  /** Escolha da pessoa usuária, incluindo `system`. */
  preference: ThemePreference;
  /** Tema aplicado ao documento agora. */
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Alterna entre claro e escuro a partir do tema em vigor. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(
    themePreference.subscribe,
    themePreference.getSnapshot,
    themePreference.getServerSnapshot,
  );

  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = resolveTheme(preference, systemPrefersDark);

  // Escrever no `<html>` é sincronizar o React com um sistema externo, que é
  // exatamente o que um efeito deve fazer. Em desenvolvimento, isso também
  // devolve o atributo que o remount do Strict Mode apaga.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    themePreference.set(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      theme,
      setPreference,
      toggle: () => setPreference(theme === "dark" ? "light" : "dark"),
    }),
    [preference, theme, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/**
 * Lê e altera o tema da aplicação.
 *
 * @example
 * const { theme, toggle } = useTheme();
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme precisa estar dentro de <ThemeProvider>.");
  }

  return context;
}

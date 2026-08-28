/**
 * @file theme.ts
 * Regras do tema claro e escuro.
 *
 * A preferência tem três valores: `light`, `dark` e `system`. O que chega ao
 * documento é sempre um dos dois primeiros, no atributo `data-theme` do
 * elemento raiz — é ele que troca os tokens semânticos em `globals.css`.
 */

import { createPersistedPreference } from "@/lib/persisted-preference";

/** Preferência escolhida pela pessoa usuária. */
export type ThemePreference = "light" | "dark" | "system";

/** Tema efetivamente aplicado ao documento. */
export type ResolvedTheme = "light" | "dark";

/** Chave usada no armazenamento local do navegador. */
export const THEME_STORAGE_KEY = "view-show:theme";

/** Preferência inicial de quem nunca escolheu: acompanha o sistema. */
export const DEFAULT_THEME: ThemePreference = "system";

function isThemePreference(raw: string): raw is ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system";
}

/** Preferência de tema guardada no navegador. */
export const themePreference = createPersistedPreference<ThemePreference>(
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  isThemePreference,
);

/**
 * Script executado antes da primeira pintura, ainda no `<head>`.
 *
 * Resolve a preferência e escreve o atributo no `<html>` para que a página já
 * nasça no tema certo. Sem isso, um recarregamento no tema escuro pisca branco
 * enquanto o React não hidrata.
 *
 * Também marca o documento com a classe `js`. É ela que autoriza o CSS a
 * esconder o conteúdo que entra por animação: sem JavaScript, nada é
 * escondido e a página continua legível.
 *
 * É uma string porque precisa ser injetada como script inline síncrono; a
 * chave e os valores são os mesmos deste módulo.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var r=document.documentElement;r.classList.add("js");try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(p!=="light"&&p!=="dark"){p=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}r.setAttribute("data-theme",p);}catch(e){r.setAttribute("data-theme","light");}})();`;

/**
 * Converte a preferência no tema que o documento deve usar.
 *
 * @param preference - Escolha da pessoa usuária.
 * @param systemPrefersDark - Se o sistema operacional pede tema escuro.
 * @returns O tema a aplicar.
 *
 * @example
 * resolveTheme("system", true); // "dark"
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

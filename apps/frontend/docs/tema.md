# Tema e preferências persistidas

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha o tema e o armazenamento de preferências; a visão geral está na seção 7
> do índice.

## As três preferências

`ThemePreference` (`lib/theme.ts`): `"light" | "dark" | "system"`. O padrão de
quem nunca escolheu é `"system"`. O que chega ao documento é sempre **um dos
dois** temas efetivos, no atributo `data-theme` do `<html>` — é ele que troca os
tokens semânticos em `app/globals.css`.

```ts
resolveTheme("system", true);  // "dark"  (SO pedindo escuro)
resolveTheme("light", true);   // "light" (escolha explícita ganha do SO)
```

## O ciclo do tema

```text
1. Servidor renderiza <html data-theme="light"> (valor conservador)
2. <head> executa THEME_BOOTSTRAP_SCRIPT (síncrono, antes da 1ª pintura):
     lê localStorage["view-show:theme"] → resolve "system" pela media query
     → escreve data-theme="light" | "dark" no <html>  → adiciona a classe "js"
3. React hidrata. <html suppressHydrationWarning> aceita o valor do documento.
4. <ThemeProvider> assina a loja e a media query; um efeito reescreve
   data-theme quando a preferência ou o gosto do SO mudam.
```

O passo 2 evita a piscada branca ao recarregar no escuro. A classe `js` no
`<html>` autoriza o CSS a esconder o conteúdo que entra por animação
(`html.js [data-reveal="hidden"] { opacity: 0 }`). **Sem JavaScript, nada é
escondido.**

## O script de bootstrap

`THEME_BOOTSTRAP_SCRIPT`, em `lib/theme.ts`, é uma **string** injetada como
`<script>` inline síncrono por `<InlineScript>` no `<head>` do `app/layout.tsx`. A
chave (`THEME_STORAGE_KEY = "view-show:theme"`) e os valores são os mesmos do
módulo.

```js
(function () {
  var r = document.documentElement;
  r.classList.add("js");
  try {
    var p = localStorage.getItem("view-show:theme");
    if (p !== "light" && p !== "dark") {
      p = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    r.setAttribute("data-theme", p);
  } catch (e) {
    r.setAttribute("data-theme", "light");
  }
})();
```

## `persisted-preference.ts`

Uma preferência é **estado externo ao React**: existe antes da app montar e
sobrevive a ela. É modelada como uma pequena loja com assinatura, lida com
`useSyncExternalStore`.

**`createPersistedPreference<T extends string>(key, fallback, isValid)`** — para
um valor de uma palavra.

| Membro | O que faz |
| --- | --- |
| `subscribe(onChange)` | Assina; escuta o evento `storage` (mudança em outra aba). Devolve o cancelador. |
| `getSnapshot()` | Valor em vigor, em cache até uma escrita. |
| `getServerSnapshot()` | Devolve `fallback` (valor conservador no servidor). |
| `set(value)` | Grava em `localStorage` e notifica os assinantes. |

**`createPersistedJson<T>(key, fallback, revive)`** — mesma ideia, para dados que
não cabem em uma palavra (o perfil da conta). `revive(raw: unknown)` converte o
objeto lido ou devolve `null` quando o conteúdo salvo não serve mais.

Armazenamento bloqueado (janela anônima, política corporativa): a preferência
**continua funcionando** — só não sobrevive ao recarregamento. Tudo em
`try/catch`.

| Chave | Loja | Conteúdo |
| --- | --- | --- |
| `view-show:theme` | `createPersistedPreference` | `light` / `dark` / `system` |
| `view-show:nav-collapsed` | `createPersistedPreference` | `true` / `false` |
| `view-show:account` | `createPersistedJson` | `{ name, photo }` |

## `useMediaQuery` e `useReducedMotion`

`hooks/use-media-query.ts` lê uma media query com `useSyncExternalStore`; **no
servidor devolve sempre `false`**. `hooks/use-reduced-motion.ts` é um atalho de
`useMediaQuery("(prefers-reduced-motion: reduce)")`, usado pelo movimento escrito
em JS (`AnimatedNumber`, o traço das séries). O CSS já respeita
`prefers-reduced-motion` sozinho.

## O tema escuro no CSS

`app/globals.css`, bloco `:root[data-theme="dark"]`. Azul-noite, derivado do navy
da marca. **Só os tokens semânticos mudam** — superfícies, tinta, bordas, tons de
estado, sombras. Nenhum componente usa a variante `dark:` do Tailwind.

| Token | Claro | Escuro |
| --- | --- | --- |
| `canvas` | `#F5F7FB` | `#060C22` |
| `surface` | `#FFFFFF` | `#0D1633` |
| `ink` | `#171A22` | `#EEF3FF` |
| `ink-muted` | `#667085` | `#A3B4DB` |
| `ink-brand` | `#0D47D9` | `#8FB3FF` |
| `line` | `#E6EAF0` | `#223059` |
| `critical-strong` | `#C4232F` | `#FF9AA2` |

Os tokens de **marca não mudam**. `ink-brand` é o azul de **texto**; `brand-blue`
fica reservado a preenchimento. No escuro, o `gradient-navy` da navegação
**clareia** em vez de escurecer.

## Onde a pessoa troca

- **Troca rápida** (claro ⇄ escuro): `ThemeToggle`, botão da barra superior.
- **Escolha completa** (com "acompanhar o sistema"): `ThemeChoice`, no guia
  `/design-system`. A tela de Configurações **não** tem controle de aparência.

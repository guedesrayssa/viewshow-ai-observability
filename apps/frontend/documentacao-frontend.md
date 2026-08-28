# Documentação do frontend do View Show

Aplicação web do View Show — a plataforma de telemetria de frontend do Globoplay
que diagnostica falhas de reprodução em minutos. Construída com **Next.js 16
(App Router)**, **React 19**, **TypeScript** e **Tailwind CSS v4**.

Este documento reúne toda a documentação do frontend. O guia visual detalhado
(tokens, componentes, contraste) continua em
[`docs/design-system.md`](./docs/design-system.md), e a versão navegável dele, em
`/design-system`.

## Sumário

1. [Início rápido](#1-início-rápido)
2. [Arquitetura](#2-arquitetura)

---

## 1. Início rápido

```bash
cd apps/frontend
npm install
npm run dev      # http://localhost:3000
```

Sem `.env.local`, a aplicação sobe em **modo de exemplo**: o login abre uma
sessão de demonstração e as telas leem o conjunto de exemplo, dizendo isso em
texto (`DataStatus`). É suficiente para desenvolver a interface inteira sem
backend.

Para apontar para uma API:

```bash
cp .env.example .env.local
# ajuste NEXT_PUBLIC_API_BASE_URL
```

| Script | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento (`next dev`). |
| `npm run build` | Build de produção (`next build`). |
| `npm run start` | Sobe o build de produção (`next start`). |
| `npm run lint` | ESLint (`eslint`). |

Pré-requisitos: **Node.js 20+** e **npm** (há `package-lock.json`). Não há suíte
de testes configurada no pacote hoje.

### Três regras que valem para qualquer tela nova

1. **Nada de cor literal fora de `app/globals.css`.** Use os tokens semânticos
   (`bg-surface`, `text-ink-muted`, `border-line`, `rounded-card`).
2. **Nada de elemento nativo estilizado à mão.** Botões, campos, cartões, selos e
   avisos vêm de `components/ui`. Se falta uma variante, ela é acrescentada ao
   componente, não improvisada na tela.
3. **Todo número passa pela camada de dados** e chega pelo `useResource`, com os
   quatro estados desenhados (esperando, com dado, atualizando, sem leitura).

---

## 2. Arquitetura

### 2.1 Stack

| Camada | Escolha | Observação |
| --- | --- | --- |
| Framework | Next.js `16.3.1`, App Router | Sem `src/`. As rotas moram em `app/`. |
| Runtime de UI | React `19.2.8` | Server Components por padrão; `"use client"` onde há estado. |
| Linguagem | TypeScript `5`, `strict` | Alias de import `@/*` → raiz de `apps/frontend`. |
| Estilo | Tailwind CSS `v4` via `@tailwindcss/postcss` | Tokens no bloco `@theme` de `app/globals.css`. |
| Tipografia | `next/font/google` (Poppins) | Baixada e hospedada junto da app, sem CDN em runtime. |
| Lint | `eslint-config-next` (core-web-vitals + typescript) | `npm run lint`. |
| Dependências de runtime | Apenas `next`, `react`, `react-dom` | Sem biblioteca de UI, de gráfico ou de ícone. |

Não há biblioteca de gerenciamento de estado, de data fetching nem de
componentes: tudo o que a aplicação precisa está no repositório (`components/`,
`hooks/`, `lib/`).

### 2.2 App Router e grupos de rota

```text
app/
├── layout.tsx              # layout raiz: idioma, fonte, tokens, tema, conta
├── page.tsx                # "/" → redirect("/login")
├── globals.css             # tokens do design system (fonte única de verdade)
├── (auth)/                 # grupo de rota: telas de acesso
│   ├── layout.tsx          # moldura com o painel ilustrado
│   ├── login/
│   └── recuperar-senha/
├── (painel)/               # grupo de rota: telas autenticadas
│   ├── layout.tsx          # renderiza <AppShell>
│   ├── sidebar-nav.tsx     # itens da navegação lateral (client)
│   ├── visao-geral/  incidentes/  evidencias/  eventos/  monitoramento/  configuracoes/
└── design-system/          # guia vivo, renderizado com o mesmo código das telas
```

Os parênteses em `(auth)` e `(painel)` marcam **grupos de rota**: organizam os
arquivos e dão um layout compartilhado sem entrar na URL. `/login` e
`/visao-geral` ficam na raiz do site.

| Rota | Conteúdo |
| --- | --- |
| `/` | Redireciona para `/login` |
| `/login` | Acesso por e-mail e senha ou SSO Globo |
| `/recuperar-senha` | Orientação de recuperação de acesso |
| `/visao-geral` | Hub do painel: estado do ecossistema em tempo quase real |
| `/incidentes` | Incidentes e degradações que exigem atenção |
| `/evidencias` | Hipótese de causa provável e evidências do diagnóstico |
| `/eventos` | Eventos e sessões correlacionados, ligados à fonte original |
| `/monitoramento` | Saúde do pipeline de telemetria e concentração geográfica |
| `/configuracoes` | Conta, notificações e acesso corporativo |
| `/design-system` | Guia vivo dos tokens e componentes |

### 2.3 As três camadas

**Moldura** (`components/shell/`) — `app/(painel)/layout.tsx` renderiza
`<AppShell>`, que reúne `Sidebar` (navegação lateral fixa), `Topbar` (barra
superior grudada no topo) e a área de conteúdo, que é a única coisa que rola. O
estado da navegação (recolhida/aberta) vive em `AppShell` e é persistido no
navegador.

**Telas** (`app/(painel)/<rota>/`) — cada tela é um conjunto de arquivos com
nomes previsíveis:

| Arquivo | Papel |
| --- | --- |
| `page.tsx` | Server Component. Só exporta `metadata` e renderiza a `*-view`. |
| `<rota>-view.tsx` | `"use client"`. Estado dos filtros, chamadas de `useResource`, layout. |
| `<rota>-resource.ts` | Funções `fetch*`: endpoint, `map` da resposta e `fallback` de exemplo. |
| `<rota>-data.ts` | Tipos, rótulos, opções de filtro e o conjunto de exemplo. |
| `<rota>-chart.tsx`, `*-table.tsx`, ... | Blocos visuais específicos da tela. |

**Dados** (`lib/data/` + `hooks/use-resource.ts`) — toda leitura de telemetria
passa por `lib/data/client.ts`, que decide entre a API e o conjunto de exemplo, e
chega ao componente pelo hook `useResource`. Detalhado na seção 4.

### 2.4 Servidor e cliente

O padrão do App Router é **Server Component**. Um arquivo só recebe `"use client"`
quando precisa de estado, efeito, contexto ou APIs do navegador.

| Roda no servidor | Roda no cliente (`"use client"`) |
| --- | --- |
| `app/layout.tsx`, todos os `page.tsx` | Todas as `*-view.tsx` |
| `app/(auth)/layout.tsx`, `recuperar-senha/page.tsx` | `AppShell`, `Sidebar`, `Topbar`, `SidebarNav` |
| `PageHeader`, `Card`, `Badge`, `Alert`, `Skeleton` | `ThemeProvider`, `AccountProvider` |
| `button-classes.ts` (aparência sem componente) | `Button`, `Select`, `TextField`, `Switch` |
| — | Gráficos, `Reveal`, `AnimatedNumber`, `DataStatus` |

`button-classes.ts` existe separado de `button.tsx` justamente para que uma tela
de servidor possa dar aparência de botão a um `<Link>` (`buttonClasses({...})`)
sem arrastar o componente cliente. O tema é resolvido **antes da primeira
pintura** por um script inline no `<head>` (seção 8).

### 2.5 Fluxo de uma tela do painel

```text
page.tsx (server)
  └─ <OverviewView> (client)
       ├─ useState(filtros)
       ├─ useResource((rev) => fetchOverview(query, rev), [deps], { refreshMs })
       │     └─ fetchOverview  →  loadResource({ path, params, map, fallback })
       │           ├─ API configurada?  → apiGet(path) → map(resposta)
       │           └─ senão / erro / timeout → fallback()  (source: "exemplo")
       ├─ PageHeader + DataStatus (procedência e frescor do dado)
       └─ estados: Skeleton | conteúdo | "atualizando…" | Alert de falha
```

Cada mudança de filtro recompõe `deps`, o que dispara nova leitura. A releitura
automática é um `setInterval` interno ao `useResource`, ligado por `refreshMs`.

### 2.6 Estado da aplicação

Não há store global. O estado mora onde faz sentido:

| Estado | Onde vive | Mecanismo |
| --- | --- | --- |
| Filtros de uma tela | A própria `*-view.tsx` | `useState` |
| Dado da telemetria | `useResource` na `*-view.tsx` | hook local |
| Navegação recolhida | `AppShell` | `createPersistedPreference` + `useSyncExternalStore` |
| Tema (light/dark/system) | `ThemeProvider` | `createPersistedPreference` + media query |
| Perfil da conta (nome, foto) | `AccountProvider` | `createPersistedJson` |
| Media queries | Componente que precisa | `useMediaQuery` (`useSyncExternalStore`) |

Preferências são **estado externo ao React**: existem antes da app montar e
sobrevivem a ela. Por isso são lidas com `useSyncExternalStore` a partir de uma
pequena loja com assinatura (`lib/persisted-preference.ts`), sem efeito de
correção depois da primeira pintura.

### 2.7 Princípios

1. **Cor literal só em `app/globals.css`.** Nas telas, o token semântico.
2. **Elemento interativo vem de `components/ui`.** Falta variante? Acrescente no
   componente, não na tela.
3. **Cor nunca comunica sozinha.** Todo estado tem rótulo textual (WCAG 2.2).
4. **Todo número passa pela camada de dados** e chega pelo `useResource`.
5. **O movimento tem que dizer algo.** A barra cresce porque a altura é o dado; a
   linha é escrita porque o eixo é o tempo. Enfeite não entra.
6. **Toda adição entra também em `/design-system`.**

---


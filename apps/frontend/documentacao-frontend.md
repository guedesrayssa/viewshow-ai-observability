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
3. [Estrutura de pastas](#3-estrutura-de-pastas)

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

## 3. Estrutura de pastas

Cada arquivo de código abre com um bloco JSDoc `/** @file … */` que explica **o
porquê** da sua existência. Esta seção é o índice.

### 3.1 Raiz

```text
apps/frontend/
├── app/                    # rotas (App Router) e tokens do design system
├── components/             # componentes de UI, agrupados por domínio
├── hooks/                  # leitura de recurso, media query e movimento
├── lib/                    # acesso, tema, formatação, camada de dados, utilitários
├── docs/design-system.md    # guia visual detalhado
├── documentacao-frontend.md # este documento
├── public/                 # assets estáticos do template do Next (não usados nas telas)
├── .env.example            # variáveis de ambiente do frontend
├── eslint.config.mjs       # ESLint (core-web-vitals + typescript do Next)
├── next.config.ts          # configuração do Next (vazia hoje)
├── postcss.config.mjs      # plugin do Tailwind v4
├── tsconfig.json           # strict, alias @/* → raiz de apps/frontend
├── AGENTS.md / CLAUDE.md    # nota do next dev sobre a versão do framework
└── README.md               # visão rápida e tabela de rotas
```

### 3.2 `app/`

```text
app/
├── globals.css             # ÚNICA fonte de verdade dos tokens visuais
├── layout.tsx              # layout raiz: <html lang>, Poppins, tokens,
│                           # THEME_BOOTSTRAP_SCRIPT no <head>, ThemeProvider,
│                           # AccountProvider, metadata e themeColor
├── page.tsx                # "/" → redirect("/login")
├── icon.svg / apple-icon.png / favicon.ico
│
├── (auth)/                            # grupo de rota — telas de acesso
│   ├── layout.tsx                     # painel navy ilustrado + coluna do form.
│   │                                  # ORBS decorativas com deriva animada
│   ├── login/
│   │   ├── page.tsx                   # server; metadata + <LoginForm>
│   │   └── login-form.tsx             # client; validação no envio, foco no
│   │                                  # 1º campo inválido, atalho de SSO
│   └── recuperar-senha/page.tsx       # server; senha é do provedor corporativo
│
├── (painel)/                          # grupo de rota — telas autenticadas
│   ├── layout.tsx                     # renderiza <AppShell>
│   ├── sidebar-nav.tsx                # client; NAV_ITEMS + item ativo pela rota
│   │
│   ├── visao-geral/
│   │   ├── page.tsx  overview-view.tsx  overview-resource.ts
│   ├── incidentes/
│   │   ├── page.tsx  incidents-view.tsx  incidents-resource.ts
│   │   ├── incidents-data.ts          # tipos, PERIOD/SORT/URGENCY, sortIncidents
│   │   └── incidents-chart.tsx        # "Dispositivos afetados por horário" (BarChart)
│   ├── evidencias/
│   │   ├── page.tsx  evidence-view.tsx  evidence-resource.ts  evidence-data.ts
│   │   └── buffering-chart.tsx        # "Buffering após a 4.2.1" (TimeSeriesChart)
│   ├── eventos/
│   │   ├── page.tsx  events-view.tsx  events-resource.ts  events-data.ts
│   │   ├── events-chart.tsx           # "Volume temporal dos eventos"
│   │   └── events-table.tsx           # tabela com detalhe expansível por linha
│   ├── monitoramento/
│   │   ├── page.tsx  monitoring-view.tsx  telemetry-resource.ts  telemetry-data.ts
│   │   ├── kpi-card.tsx               # cartão de indicador do pipeline
│   │   ├── processing-flow-chart.tsx  # ingestão × processamento + meta + pico
│   │   ├── sources-table.tsx          # última atualização, cobertura, estado
│   │   ├── geographic-map.tsx         # concentração por UF, 5 níveis + resumo textual
│   │   └── br-states-geometry.ts      # contornos das UFs, gerados dos limites do IBGE
│   └── configuracoes/page.tsx         # server; PageHeader + 5 cartões de settings/
│
└── design-system/
    ├── page.tsx                       # guia vivo: tokens + componentes reais
    ├── select-preview.tsx  switch-preview.tsx
```

### 3.3 `components/`

```text
components/
├── account/account-provider.tsx  # perfil (nome, foto) em sessão; useAccount()
│
├── charts/                        # ver seção 7
│   ├── time-series-chart.tsx      # <TimeSeriesChart> + <ChartLegend> (linha)
│   ├── bar-chart.tsx             # <BarChart> (faixas discretas)
│   ├── chart-tooltip.tsx        # balão de leitura por cursor
│   └── scales.ts               # niceMax, axisTicks, labelStep, toPlot, paths
│
├── dashboard/
│   ├── page-header.tsx           # abertura padrão de tela
│   ├── data-status.tsx           # procedência + frescor + botão atualizar
│   ├── filter-bar.tsx            # barra de recorte da Visão Geral (não guarda estado)
│   ├── stat-card.tsx             # cartão de indicador (valor conta até o lido)
│   ├── experience-health-card.tsx  # "Saúde da experiência" (série × base)
│   ├── incidents-card.tsx        # lista curta de incidentes + link para a tela
│   └── incident-row.tsx          # linha de um incidente na lista curta
│
├── motion/
│   ├── reveal.tsx                # <Reveal>: entrada única de conteúdo, cascata por index
│   └── animated-number.tsx       # <AnimatedNumber>: conta do valor anterior ao atual
│
├── settings/
│   ├── profile-card.tsx          # foto: vale na hora, sem salvar
│   ├── account-details-card.tsx  # nome/time/fuso: nome só vale ao salvar
│   ├── notifications-card.tsx    # switches de preferência de alerta
│   ├── access-security-card.tsx  # método de entrada e sessões ativas
│   └── danger-zone-card.tsx      # excluir conta (borda critical)
│
├── shell/
│   ├── app-shell.tsx             # moldura: sidebar + topbar + conteúdo; estado da nav
│   ├── sidebar.tsx               # navegação lateral fixa / folha sobreposta
│   └── topbar.tsx               # barra superior grudada: recolher, tema, conta
│
├── theme/
│   ├── theme-provider.tsx        # useTheme(); escreve data-theme no <html>
│   └── theme-toggle.tsx         # <ThemeToggle> (topo) e <ThemeChoice> (guia)
│
├── ui/                           # biblioteca base — ver seção 6
│   ├── button.tsx / button-classes.ts
│   ├── input.tsx  select.tsx  card.tsx  badge.tsx  alert.tsx  switch.tsx
│   ├── avatar.tsx  skeleton.tsx  logo.tsx  wordmark.tsx  icons.tsx
│
└── inline-script.tsx            # <script> síncrono no <head> (usado pelo tema)
```

### 3.4 `hooks/`

| Hook | Para quê |
| --- | --- |
| `use-resource.ts` | Ciclo de vida de um dado do painel: os quatro estados + releitura manual e automática. |
| `use-media-query.ts` | Leitura reativa de uma media query via `useSyncExternalStore`. No servidor devolve `false`. |
| `use-reduced-motion.ts` | Atalho de `useMediaQuery("(prefers-reduced-motion: reduce)")` para o movimento escrito em JS. |
| `use-element-size.ts` | Tamanho renderizado de um elemento (`ResizeObserver`), para os gráficos desenharem em pixels reais. |

### 3.5 `lib/`

| Módulo | Responsabilidade |
| --- | --- |
| `data/client.ts` | Ponte com a API: `apiGet`, `loadResource`, `isApiConfigured`, `jitter`, tipos `Resource`/`DataSource`, `ApiError`. |
| `data/endpoints.ts` | `ENDPOINTS`: caminhos publicados pela API, espelhando `apps/basica/backend`. |
| `auth.ts` | Regras de acesso: `validateEmail`, `validatePassword`, `isCorporateEmail`, `signIn`, `ssoEntryPoint`. |
| `theme.ts` | `ThemePreference`, `resolveTheme`, `themePreference` (loja), `THEME_BOOTSTRAP_SCRIPT`. |
| `persisted-preference.ts` | `createPersistedPreference` (valor simples) e `createPersistedJson` (objeto), com assinatura para `useSyncExternalStore`. |
| `format.ts` | Formatação numérica pt-BR: `formatInteger`, `formatDecimal`, `formatCompact`, `formatPercent`, `formatSignedPercent`. |
| `image.ts` | `readSquareImage`: corta em quadrado e reduz a 320 px a foto de perfil, no navegador. |
| `cn.ts` | `cn(...)`: concatena classes ignorando valores falsos. **Não** resolve conflitos do Tailwind. |
| `dashboard-data.ts` | Tipos, opções de filtro e conjunto de exemplo da Visão Geral. |
| `settings-data.ts` | `ACCOUNT_PROFILE`, opções de time/fuso/tela inicial, `NOTIFICATION_PREFERENCES`. |

---


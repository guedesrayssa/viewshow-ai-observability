# Documentação do frontend do View Show

Aplicação web do View Show — a plataforma de telemetria de frontend do Globoplay
que diagnostica falhas de reprodução em minutos. Construída com **Next.js 16
(App Router)**, **React 19**, **TypeScript** e **Tailwind CSS v4**.

Este é o **ponto de entrada** da documentação: reúne a visão geral e as seções
transversais. Os domínios mais autocontidos moram em arquivos próprios dentro de
`docs/`, no mesmo padrão já usado para o guia visual:

| Documento | Cobre |
| --- | --- |
| [`docs/camada-de-dados.md`](./docs/camada-de-dados.md) | `client.ts`, `endpoints.ts`, `useResource`, os quatro estados, `*-resource`/`*-data`, `DataStatus` |
| [`docs/componentes.md`](./docs/componentes.md) | Catálogo de `components/` e os dois componentes de gráfico |
| [`docs/tema.md`](./docs/tema.md) | As três preferências, o script de bootstrap, `persisted-preference`, tema escuro no CSS |
| [`docs/autenticacao.md`](./docs/autenticacao.md) | `auth.ts`, login, SSO, sessão de demonstração, `AccountProvider`, foto de perfil |
| [`docs/design-system.md`](./docs/design-system.md) | Tokens, componentes e regras de uso, com valores e contraste. Versão navegável em `/design-system` |

## Sumário

1. [Início](#1-início)
2. [Arquitetura](#2-arquitetura)
3. [Estrutura de pastas](#3-estrutura-de-pastas)
4. [Telas](#4-telas)
5. [Camada de dados](#5-camada-de-dados)
6. [Catálogo de componentes e gráficos](#6-catálogo-de-componentes-e-gráficos)
7. [Tema e preferências persistidas](#7-tema-e-preferências-persistidas)
8. [Autenticação e conta](#8-autenticação-e-conta)
9. [Design system e movimento](#9-design-system-e-movimento)
10. [Acessibilidade](#10-acessibilidade)
11. [Desenvolvimento e convenções](#11-desenvolvimento-e-convenções)
12. [Referências do projeto](#12-referências-do-projeto)

---

## 1. Início

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

As convenções que valem para qualquer tela nova — cor via token semântico,
elementos interativos de `components/ui`, dados pelo `useResource` — estão
reunidas na [seção 2.7](#27-princípios).

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
chega ao componente pelo hook `useResource`. Detalhado em
[`docs/camada-de-dados.md`](./docs/camada-de-dados.md).

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
pintura** por um script inline no `<head>` (ver [`docs/tema.md`](./docs/tema.md)).

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
correção depois da primeira pintura. Contrato da loja em
[`docs/tema.md`](./docs/tema.md).

### 2.7 Princípios

- **Cor** vive em `app/globals.css` como token semântico (`bg-surface`,
  `text-ink-muted`, `border-line`, `rounded-card`); as telas consomem o token, e
  não o valor literal. É o que permite o tema escuro reescrever apenas os tokens,
  sem tocar em nenhum componente.
- **Elementos interativos** — botões, campos, cartões, selos, avisos — vêm de
  `components/ui`, que já carrega altura, raio, foco e estados corretos. Quando
  falta uma variante, ela é acrescentada ao componente, e chega às telas por lá.
- **O estado é comunicado por texto além da cor:** todo `Badge`, `Alert` e
  legenda de gráfico leva rótulo textual, seguindo as WCAG 2.2.
- **Os números da tela vêm da camada de dados**, pelo `useResource`, com os
  quatro estados desenhados (esperando, com dado, atualizando, sem leitura). O
  conjunto de exemplo entra como `fallback` de um recurso, nunca importado direto
  na tela.
- **O movimento carrega informação:** a barra cresce porque a altura é o dado, a
  linha é escrita porque o eixo é o tempo, o número conta porque acabou de ser
  lido. Movimento que não diz nada fica de fora.
- **Cada token ou componente novo aparece também em `/design-system`**, que
  renderiza o guia com o mesmo código das telas.

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
├── docs/                   # documentação por domínio
│   ├── camada-de-dados.md  componentes.md  tema.md  autenticacao.md
│   └── design-system.md    # guia visual detalhado
├── documentacao-frontend.md # ponto de entrada da documentação
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
├── charts/                        # ver docs/componentes.md
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
├── ui/                           # biblioteca base — ver docs/componentes.md
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

Detalhe de `data/*` em [`docs/camada-de-dados.md`](./docs/camada-de-dados.md); de
`theme.ts` e `persisted-preference.ts` em [`docs/tema.md`](./docs/tema.md); de
`auth.ts` e `image.ts` em [`docs/autenticacao.md`](./docs/autenticacao.md).

---

## 4. Telas

Toda tela do painel segue a mesma montagem: `page.tsx` (server, só `metadata` +
`*-view`); `*-view.tsx` (client, filtros em `useState`, dados por `useResource`);
`PageHeader` no topo com `status` (um `<DataStatus>`) e `actions`; cascata de
entrada por `<Reveal delay>`; os quatro estados de dado; filtro controlado pela
tela (é ela que refaz a leitura da telemetria).

### `/login`

| | |
| --- | --- |
| Arquivos | `app/(auth)/login/page.tsx`, `login-form.tsx`; moldura em `app/(auth)/layout.tsx` |
| Regras | `lib/auth.ts` — RF04, RIE01, RESTR01 |

Acesso por e-mail e senha, com atalho de **SSO Globo**. Moldura com painel navy
ilustrado à esquerda (esferas com deriva animada, decorativo e `aria-hidden`);
abaixo de `lg` o painel some. Validação **no envio**, não a cada tecla; depois do
primeiro envio, o erro de cada campo some quando o valor muda; o foco vai para o
primeiro campo inválido; `<form noValidate>`. Qualquer e-mail válido entra; se o
domínio é `@globo.com`, a tela sugere o SSO. Detalhes de rede em
[`docs/autenticacao.md`](./docs/autenticacao.md).

### `/recuperar-senha`

Tela estática (Server Component). A senha pertence ao provedor corporativo
(RESTR01): a plataforma não a redefine. Orienta a procurar o suporte interno de
TI e volta ao login.

### `/visao-geral`

| | |
| --- | --- |
| Arquivos | `page.tsx`, `overview-view.tsx`, `overview-resource.ts`; dados em `lib/dashboard-data.ts` |
| Recurso | `fetchOverview` → `ENDPOINTS.realtimeOverview` |
| Releitura | automática a cada **30 s** |
| Filtros | período, dispositivo, região, versão do app (`FilterBar`) |

Hub do painel. Três `StatCard` (taxa de erros `critical`, latência p95 `warning`,
sessões afetadas `info` — valor conta até o lido, comparação com a base em
texto); `FilterBar` (não guarda estado, emite `onChange`); `ExperienceHealthCard`
(série × linha de base, janela anômala destacada, pico anotado); `IncidentsCard`
(lista curta priorizada, com link para `/incidentes`).

### `/incidentes`

| | |
| --- | --- |
| Arquivos | `page.tsx`, `incidents-view.tsx`, `incidents-resource.ts`, `incidents-data.ts`, `incidents-chart.tsx` |
| Recursos | `fetchIncidents` → `realtimeAlerts`; `fetchAffectedDevices` → `errorsTop` |
| Releitura | automática a cada **45 s** |
| Histórias | US-N1-01 (incidentes priorizados), US-N1-04 (segmentar o incidente) |

Busca por título, quatro filtros (período, dispositivo, região, versão),
ordenação (`urgency`/`devices`/`recency` via `sortIncidents`) e "Limpar filtros".
O recorte dos selects vai para a leitura da telemetria; a **busca por título é
local** (acompanha a digitação). `IncidentsChart` = "Dispositivos afetados por
horário" (`BarChart`), com janela própria. A tabela rola no eixo x em telas
estreitas; cada linha tem faixa lateral pela urgência e um link
`Ver evidências` → `/evidencias?incidente=<id>`.

### `/evidencias`

| | |
| --- | --- |
| Arquivos | `page.tsx`, `evidence-view.tsx`, `evidence-resource.ts`, `evidence-data.ts`, `buffering-chart.tsx` |
| Recursos | `fetchEvidence` → `rcaCorrelations`; `fetchBuffering` → `qoeTimeseries` (`metric=buffer_ratio`) |
| Parâmetro de URL | `?incidente=<id>` (padrão: `falhas-reproducao-tvs-lg`) |
| Histórias | US-N1-02, US-N1-03, US-N1-05, US-ENG-01 |

A tela é um argumento, e a ordem em que se monta é a ordem do argumento:
(1) resumo do incidente (`Card accent="critical"`, sessões afetadas com número
animado); (2) hipótese (`Card accent="info"`, barra de confiança que preenche até
o grau lido, ações **Confirmar**/**Refutar** — ao decidir, o selo troca e aparece
a assinatura `<nome> · agora`, com o nome vindo do `AccountProvider`);
(3) `BufferingChart` (o salto do buffer ratio após o deploy destacado);
(4) concentração afetada (barras de proporção com nota em texto); (5) evidências
por fonte (acordeão, uma aberta por vez, detalhe abrindo em altura); (6) linha do
tempo com janela selecionável. `DataStatus` usa `showSource={false}` (o cabeçalho
já carrega o código do incidente).

### `/eventos`

| | |
| --- | --- |
| Arquivos | `page.tsx`, `events-view.tsx`, `events-resource.ts`, `events-data.ts`, `events-chart.tsx`, `events-table.tsx` |
| Recursos | `fetchEvents` → `rcaFingerprints`; `fetchEventVolume` → `qoeTimeseries` (`metric=events_per_minute`) |
| Recorte inicial | Smart TV · Nordeste · App 4.2.1 · últimos 30 min (herdado do INC-4821) |
| Histórias | US-ENG-02, US-ENG-03 |

Busca global (resumo, entidade, fonte) + filtros + abas por tipo com contagem
(`CATEGORY_STATS`) + filtro de fonte + "Mais filtros" (lista os filtros ainda sem
tela própria) + "Limpar filtros". A leitura chega recortada; **busca e tipo
continuam locais**. `EventsChart` = "Volume temporal dos eventos"
(`TimeSeriesChart`). `EventsTable` = detalhe expansível por linha (US-ENG-02): ao
abrir, mostra o dado normalizado (métrica, timestamp, tags, valor) e a ligação
com a fonte original, sinalizando quando não há correspondência bruta direta. Uma
linha aberta por vez.

### `/monitoramento`

| | |
| --- | --- |
| Arquivos | `page.tsx`, `monitoring-view.tsx`, `telemetry-resource.ts`, `telemetry-data.ts`, `kpi-card.tsx`, `processing-flow-chart.tsx`, `sources-table.tsx`, `geographic-map.tsx`, `br-states-geometry.ts` |
| Recursos | `fetchTelemetrySources` → `rcaTopology`; `fetchGeographicConcentration` → `breakdownNetwork` |
| Releitura | automática a cada **20 s** (o pipeline muda de estado em segundos) |
| Histórias | US-ENG-04, US-ENG-05, US-PM-02 a US-PM-05 |

Filtros técnicos (fonte, métrica, worker, janela de comparação) que mudam **todos
os painéis**. Aviso de atraso (`Badge critical`) quando uma fonte atrasada está no
recorte. Quatro `KpiCard` (ingestão, latência de processamento contra
`LATENCY_TARGET`, profundidade da fila, DLQ — cada um com nota em texto).
`ProcessingFlowChart` (ingestão × processamento na ordem do pipeline, meta e pico,
cursor lendo as duas séries). `SourcesTable` (última atualização, cobertura,
estado — selo de texto; linha da fonte atrasada com fundo próprio só como
reforço). `GeographicMap` (concentração por **UF**, contorno do IBGE, escala de
cinco níveis nunca isolada: cada estado alcançável por teclado, resumo por região
em texto abaixo).

### `/configuracoes`

`PageHeader` (só título) e cinco cartões em cascata:

| Cartão | Comportamento |
| --- | --- |
| `ProfileCard` | **Foto**: vale na hora, sem botão de salvar. Cortada em quadrado e reduzida a 320 px no navegador (`lib/image.ts`). |
| `AccountDetailsCard` | **Nome**: só vale ao salvar (assina registros em Evidências). Time e fuso via `Select`. |
| `NotificationsCard` | `Switch` por preferência (`NOTIFICATION_PREFERENCES`), efeito imediato. |
| `AccessSecurityCard` | Método de entrada e sessões ativas (`ACCOUNT_PROFILE`). |
| `DangerZoneCard` | Excluir conta — `Card borderTone="critical"`, `Button variant="danger"`. |

A **escolha de aparência não fica aqui**: é ação da barra superior.

### `/design-system`

Guia vivo: renderiza tokens e componentes com o **mesmo código** das telas, para
nunca ficar desatualizado. Referência textual em
[`docs/design-system.md`](./docs/design-system.md).

---

## 5. Camada de dados

Nenhuma tela do painel lê `fetch` diretamente nem importa medição de um módulo de
exemplo: toda leitura passa por `lib/data/client.ts`, que decide entre a API e o
conjunto de exemplo, e chega ao componente pelo hook `useResource` com quatro
estados prontos — esperando, com dado, atualizando e sem leitura. O selo
`DataStatus` mantém a procedência do número visível na tela, e ligar o backend é
preencher `NEXT_PUBLIC_API_BASE_URL` e escrever o `map` de cada `*-resource.ts` —
nenhum componente muda.

`client.ts`, `endpoints.ts`, o contrato do `useResource`, o par
`*-resource.ts` / `*-data.ts` de cada tela e o roteiro para ligar o backend ou
criar um recurso estão em
**[`docs/camada-de-dados.md`](./docs/camada-de-dados.md)**.

---

## 6. Catálogo de componentes e gráficos

`components/` reúne a biblioteca base (`ui/`), a moldura das telas (`shell/`), os
blocos do painel (`dashboard/`), a entrada de conteúdo e os números animados
(`motion/`), os cartões de Configurações (`settings/`), o tema (`theme/`) e o
perfil em sessão (`account/`). Os cinco gráficos do painel saem de dois
componentes em `components/charts/`: `TimeSeriesChart` para séries no tempo e
`BarChart` para faixas discretas.

O catálogo completo — props, variantes e regras de composição de cada componente,
e as decisões de escala, cor e leitura por cursor dos gráficos — está em
**[`docs/componentes.md`](./docs/componentes.md)**.

---

## 7. Tema e preferências persistidas

A preferência de tema tem três valores (`light`, `dark`, `system`) e é resolvida
antes da primeira pintura por um script inline no `<head>`, para não piscar
branco ao recarregar. Ela e as outras preferências da pessoa (navegação
recolhida, perfil da conta) vivem em `lib/persisted-preference.ts`, uma pequena
loja com assinatura lida por `useSyncExternalStore`.

O ciclo do tema, o script de bootstrap, o contrato de `persisted-preference.ts`,
os hooks de media query e a tabela de tokens do tema escuro estão em
**[`docs/tema.md`](./docs/tema.md)**.

---

## 8. Autenticação e conta

O View Show não guarda senha nem valida credencial: a autenticação é delegada ao
serviço de identidade (RIE01, RESTR01). O frontend cuida da validação de
formulário, do envio ao provedor, do SSO Globo e — sem `NEXT_PUBLIC_API_BASE_URL`
— de uma sessão de demonstração que mantém o painel utilizável. O perfil em
sessão (nome e foto) vive no `AccountProvider` e é lido pela navegação, pela
barra superior, pelo `Avatar` e pela assinatura de quem confirma uma hipótese.

`lib/auth.ts`, o fluxo de login com as respostas da API, o SSO, a sessão de
demonstração, o `AccountProvider` e o preparo da foto de perfil estão em
**[`docs/autenticacao.md`](./docs/autenticacao.md)**.

---

## 9. Design system e movimento

O guia completo de tokens, com valores e critérios de uso, está em
[`docs/design-system.md`](./docs/design-system.md). Resumo do essencial:

### 9.1 Tokens

`app/globals.css` é a **única fonte de verdade**. O bloco `@theme` do Tailwind v4
declara os tokens, e cada token vira utilitário automaticamente:
`--color-ink-muted` produz `text-ink-muted`, `bg-ink-muted` e `border-ink-muted`.

- **Espaçamento**: `--spacing: 0.2rem` (contra os `0.25rem` padrão) — muda a
  densidade da interface inteira de uma vez. Coloca o painel na densidade de quem
  trabalha com o navegador em 80%.
- **Tipografia**: Poppins em quatro pesos (400/500/600/700), via `next/font`. Cada
  token de tamanho (`text-h1`, `text-body`, `text-caption`…) já embute entrelinha,
  peso e tracking.
- **Cores de marca**: `brand-blue`, `brand-blue-light`, `brand-navy`,
  `brand-orange`, `brand-red`. Azul e navy sustentam a estrutura; laranja e
  vermelho ficam reservados a ações primárias e atenção.
- **Estados**: `critical`, `warning`, `info`, `success`. Cada um tem `-soft`
  (fundo de selos/avisos) e `-strong` (cor do texto — a cor cheia da marca não
  alcança 4,5:1 em textos pequenos).
- **Superfícies e texto**: `canvas`, `surface`, `surface-muted`, `ink`,
  `ink-muted`, `ink-subtle`, `ink-brand`, `line`, `line-strong`.
- **Raios**: `rounded-field` (10 px), `rounded-card` (14 px), `rounded-panel`
  (20 px), `rounded-pill`.
- **Sombras**: `shadow-card` (assenta o cartão), `shadow-raised` (menus,
  popovers), `shadow-brand` (só o botão em gradiente).
- **Gradientes**: `bg-gradient-brand` (laranja→vermelho, marca **ação**),
  `bg-gradient-navy` (painéis escuros), `bg-gradient-orb` (esferas do login).

### 9.2 Movimento

O movimento também é token. Os tempos e as curvas ficam em `@theme`, e cada
utilitário `animate-*` traz duração e curva prontas.

| Token | Duração | Uso |
| --- | --- | --- |
| `animate-fade-in` | 0,4 s | Aparição de apoio: área de gráfico, rótulo, aviso |
| `animate-rise` | 0,55 s | Entrada de bloco: cabeçalho, cartão, painel |
| `animate-rise-sm` | 0,4 s | Entrada de item de lista ou linha de tabela |
| `animate-scale-in` | 0,45 s | Entrada de selo, aba e do símbolo da marca |
| `animate-slide-in-left` | 0,45 s | Entrada dos itens da navegação lateral |
| `bar-grow` | 0,8 s | Barra de gráfico crescendo da base |
| `track-grow` | 0,9 s | Barra horizontal de proporção preenchendo |
| `animate-draw` | 1,15 s | Série temporal sendo escrita da esquerda para a direita |
| `animate-pop` | 0,5 s | Marcador de pico, depois que a linha chega nele |
| `skeleton` | contínuo | Espaço reservado enquanto o dado não chegou |

Regras: o movimento tem que dizer algo (a barra cresce porque a altura é o dado);
entrada é uma coisa só (`<Reveal>`, passo padrão de 70 ms); número que muda usa
`<AnimatedNumber>`; nada disso é condição para ler a tela (sem JS o conteúdo
aparece inteiro; com `prefers-reduced-motion: reduce`, as durações caem para
`0.01ms`).

### 9.3 Contenção visual

O gradiente da marca marca **ação**, não decoração: fica na ação primária, no
item ativo da navegação e no retrato da conta. Saiu das faixas de topo dos
cartões e das barras de proporção, que passaram a usar a cor do estado que
representam. O cartão se separa do fundo pela borda; a sombra apenas assenta a
peça. Cartão não levanta quando o ponteiro passa.

---

## 10. Acessibilidade

Adotamos as **WCAG 2.2**. Pontos aplicados no código:

- **Contraste**: `ink` sobre `surface` alcança 17,4:1 e `ink-muted` sobre
  `surface`, 5,0:1 (acima do mínimo AA de 4,5:1). No tema escuro, `ink` sobre
  `surface` alcança 15,1:1 e `ink-muted`, 7,2:1.
- **Foco**: anel de 2 px em `brand-blue-light` com deslocamento de 2 px em todo
  elemento interativo (utilitário `focus-ring` / regra base em `globals.css`),
  atendendo ao critério 2.4.11 (Focus Appearance).
- **Cor nunca comunica sozinha**: todo estado tem rótulo textual (`Badge`,
  `Alert`, legendas de gráfico, resumo por região no mapa).
- **Formulários**: rótulo associado por `htmlFor`, `aria-invalid` no campo com
  erro e `aria-describedby` apontando para a mensagem em vigor. Erros de envio em
  um `Alert` com `role="alert"`, e o foco vai para o primeiro campo inválido.
- **`Select`** implementa o teclado do seletor nativo e anuncia a opção ativa por
  `aria-activedescendant` (papéis `combobox`/`listbox`).
- **Gráficos**: cada um traz a série inteira descrita em `ariaLabel` (começo,
  pico, fim); o balão do cursor é `aria-hidden`; todo movimento respeita
  `prefers-reduced-motion`, inclusive a contagem de números e o traço das séries,
  escritos em JS.
- **Mapa de concentração**: cada estado é alcançável por teclado e anuncia nome,
  valor e intensidade; o resumo por região aparece em texto abaixo.
- **Navegação recolhida** mantém o rótulo no DOM (`sr-only`) e o repete como dica
  visual no hover.
- **Ilustrações decorativas** (painel do login) ficam com `aria-hidden`.
- **Sem JavaScript**, o conteúdo que entra por animação aparece inteiro.

### Limitações conhecidas

| Situação | Contraste | Como conviver |
| --- | --- | --- |
| Texto branco sobre `gradient-brand` | 2,9:1 a 3,7:1 | Restrito a rótulo de botão em negrito. A ação nunca é a única forma de entender a tela. |
| `ink-subtle` sobre `surface` | 2,6:1 | Uso limitado a placeholder e texto decorativo. Informação que precisa ser lida usa `ink-muted` ou mais escuro. |

---

## 11. Desenvolvimento e convenções

### 11.1 Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Endereço da API que intermedia autenticação e telemetria. Sem ela: telas em modo de exemplo e login em sessão de demonstração. |

O prefixo `NEXT_PUBLIC_` é obrigatório para o valor chegar ao navegador — e por
isso **nada com segredo** deve usar esse prefixo. `.env.local` não é versionado;
`.env.example` documenta o formato.

### 11.2 Alias de import

`tsconfig.json` define `"@/*": ["./*"]` a partir da raiz de `apps/frontend`:

```ts
import { Button } from "@/components/ui/button";
import { useResource } from "@/hooks/use-resource";
import { ENDPOINTS } from "@/lib/data/endpoints";
```

### 11.3 Convenções

- **Server Component por padrão.** `"use client"` só quando há estado, efeito,
  contexto ou API do navegador.
- **Estrutura de uma tela nova** em `app/(painel)/<rota>/`: `page.tsx` (server,
  só `metadata` + `*-view`), `<rota>-view.tsx` (client), `<rota>-resource.ts`
  (tipos `*Response` + `fetch*` com `loadResource`), `<rota>-data.ts` (tipos,
  rótulos, opções, exemplo **numérico**), blocos visuais.
- **Cabeçalho de tela é `<PageHeader>`.**
- **JSDoc**: cada arquivo abre com `/** @file … */` explicando **o porquê**, não o
  que o código faz linha a linha.
- **Idioma**: código, comentários, rotas e textos de interface em **pt-BR**.
  Símbolos seguem o inglês quando é o idioma da API/DOM (`fetchOverview`,
  `onValueChange`).
- `cn` (`lib/cn.ts`) **não** resolve conflitos de utilitário do Tailwind — não
  conte com sobrescrever cor/tamanho pelo `className`; use variantes do
  componente.

### 11.4 Nota sobre a versão do Next

`AGENTS.md` / `CLAUDE.md` trazem um bloco escrito pelo próprio `next dev`: esta é
uma versão do Next com breaking changes (APIs, convenções, estrutura de
arquivos). Ao mexer em recursos do framework, consulte
`node_modules/next/dist/docs/` (resolvido a partir de `apps/frontend/`). O bloco é
reescrito pelo `next dev` — commitá-lo junto do trabalho mantém a árvore limpa.
Já adotados: `LayoutProps<"/">` e tipos de rota gerados; `metadata`/`viewport`
exportados de `page.tsx`/`layout.tsx`; `next/font/google` hospedando a fonte
localmente.

### 11.5 Checklist de PR

- [ ] `npm run lint` sem erros.
- [ ] `npm run build` passa.
- [ ] Sem cor literal fora de `app/globals.css`.
- [ ] Sem elemento nativo estilizado à mão onde há componente em `components/ui`.
- [ ] Todo dado novo passa por um `*-resource.ts` e chega pelo `useResource`, com
      os quatro estados desenhados.
- [ ] Estado (loading / ready / atualizando / error) visível na tela, com
      `<DataStatus>` no cabeçalho.
- [ ] Movimento novo é um token `animate-*`.
- [ ] Contraste e rótulo textual em todo estado colorido (WCAG 2.2).
- [ ] Token ou componente novo refletido em `/design-system`.

---

## 12. Referências do projeto

- [`apps/frontend/README.md`](./README.md) — visão rápida e tabela de rotas.
- [`docs/design-system.md`](./docs/design-system.md) — guia visual detalhado
  (tokens, componentes, contraste). Versão navegável em `/design-system`.
- [Entendimento da experiência do usuário](../../artefatos/entendimento_ux.md) —
  personas, fluxos e a prancha de fundamentos visuais.
- [Especificação de requisitos](../../artefatos/requisitos.md) — RF04, RNF04,
  RIE01 e RESTR01, que definem as regras de acesso.
- [Protótipo no Figma](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437).
- [Demonstração em vídeo](https://youtu.be/Gur7yoTiQI0) — demonstração do
  funcionamento do frontend integrado ao backend.

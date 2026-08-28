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
4. [Camada de dados](#4-camada-de-dados)
5. [Telas](#5-telas)
6. [Catálogo de componentes](#6-catálogo-de-componentes)
7. [Gráficos](#7-gráficos)
8. [Tema e preferências persistidas](#8-tema-e-preferências-persistidas)
9. [Autenticação e conta](#9-autenticação-e-conta)
10. [Design system e movimento](#10-design-system-e-movimento)
11. [Acessibilidade](#11-acessibilidade)

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

## 4. Camada de dados

Nenhuma tela do painel lê `fetch` diretamente nem importa medição de um módulo de
exemplo: tudo passa por `lib/data/client.ts` e chega ao componente pelo
`useResource`.

```text
componente (*-view.tsx)
   │  useResource((rev) => fetchX(query, rev), [deps], { refreshMs })
   ▼
fetchX  (em <rota>-resource.ts)
   │  loadResource({ path, params, map, fallback })
   ▼
lib/data/client.ts
   ├─ API configurada (NEXT_PUBLIC_API_BASE_URL)?
   │     ├─ sim  → apiGet(path, params) → map(resposta)  → source: "api"
   │     └─ erro / timeout / 4xx-5xx    → fallback()      → source: "exemplo"
   └─ não → fallback()                                    → source: "exemplo"
```

A tela declara **o que** quer; a camada decide **de onde** vem. Trocar a fonte
não toca em nenhum componente.

### 4.1 `lib/data/client.ts`

- **`isApiConfigured(): boolean`** — `true` quando `NEXT_PUBLIC_API_BASE_URL` não
  está vazia.
- **`apiGet<T>(path, params?): Promise<T>`** — leitura na API com corpo já
  convertido de JSON. Timeout de **8 s** (`AbortController`); `cache: "no-store"`
  (o painel mostra o estado agora, não um número de cache); lança `ApiError`
  (com `status?: number`) quando a API não está configurada, demora demais ou
  responde fora de 2xx.
- **`loadResource<TResponse, TData>({ path, params?, map, fallback })`** — o ponto
  de integração de cada bloco de tela:

  | Campo | O que é |
  | --- | --- |
  | `path` | Caminho do endpoint (use `ENDPOINTS.*`). |
  | `params` | `Record<string, string \| number \| undefined>`. Chaves `undefined` são omitidas da query. |
  | `map` | Converte a resposta da API no formato que a tela desenha. |
  | `fallback` | Conjunto de exemplo, usado quando a API não responde. |

  Devolve `Resource<T>`:

  ```ts
  type Resource<T> = {
    data: T;
    source: "api" | "exemplo";
    fetchedAt: Date;          // para o rótulo "atualizado há…"
    fallbackReason?: string;  // motivo da queda para o exemplo, quando houve
  };
  ```

  Nunca rejeita: falha de API vira `source: "exemplo"` com `fallbackReason`.

- **`jitter(value, seed, amplitude = 0.06): number`** — oscila um valor de exemplo
  de forma **determinística** (a mesma leitura devolve sempre o mesmo número).
  Serve para uma atualização sem API ainda mostrar movimento, em vez de repetir o
  mesmo quadro. O selo "Dados de exemplo" fica visível o tempo todo.

### 4.2 `lib/data/endpoints.ts`

`ENDPOINTS` reúne os caminhos publicados pela API, espelhando os controllers de
`apps/basica/backend/`.

| Chave | Caminho | Serve |
| --- | --- | --- |
| `realtimeOverview` | `/v1/analytics/realtime/overview` | CCU, volume de eventos, taxa de erros do recorte |
| `realtimeAlerts` | `/v1/analytics/realtime/alerts` | Alertas e anomalias ativos |
| `qoeMetrics` | `/v1/analytics/qoe/metrics` | VST, rebuffer rate, bitrate médio |
| `qoeTimeseries` | `/v1/analytics/qoe/timeseries` | Série temporal de qualidade de experiência |
| `errorsSummary` | `/v1/analytics/errors/summary` | Resumo de erros e sessões sem falha |
| `errorsTop` | `/v1/analytics/errors/top` | Códigos de erro mais frequentes |
| `errorDetails(code)` | `/v1/analytics/errors/{code}/details` | Detalhe de um código |
| `breakdownDevices` | `/v1/analytics/breakdown/devices` | Segmentação por dispositivo/SO/versão |
| `breakdownNetwork` | `/v1/analytics/breakdown/network` | Segmentação por ISP/CDN/conexão |
| `rcaModules` | `/v1/analytics/rca/modules-breakdown` | Saúde dos módulos (causa provável) |
| `rcaTopology` | `/v1/analytics/rca/topology-health` | Saúde da topologia de processamento |
| `rcaFingerprints` | `/v1/analytics/rca/fingerprints` | Assinaturas de falha agrupadas |
| `rcaCorrelations` | `/v1/analytics/rca/correlations` | Correlações entre mudanças e degradações |

`ApiWindow`: `"5m" | "15m" | "30m" | "1h" | "6h" | "24h"`.

> Alguns `*-resource.ts` ainda apontam para o endpoint mais próximo disponível
> (Eventos usa `rcaFingerprints`, por exemplo). Ao ligar o backend, ajuste `path`
> e `map` para a rota definitiva.

### 4.3 O hook `useResource`

```ts
const overview = useResource(
  (revision) => fetchOverview(toQuery(filters), revision),
  [filters.timeRange, filters.device, filters.region, filters.appVersion],
  { refreshMs: 30_000 },
);
```

| Parâmetro | Tipo | Papel |
| --- | --- | --- |
| `load` | `(revision: number) => Promise<Resource<T>>` | Função de leitura. Recebe a revisão, para o exemplo variar entre atualizações. |
| `deps` | `readonly unknown[]` | Ao mudar, dispara nova leitura (filtros, período, recorte). |
| `options.refreshMs` | `number` | Intervalo de releitura automática. |
| `options.enabled` | `boolean` (padrão `true`) | Desliga a leitura para dependências que ainda não estão prontas. |

Retorno (`UseResourceResult<T>`): `data?`, `status` (`"loading" | "ready" |
"error"`), `refreshing` (releitura com o dado anterior na tela), `error?`,
`source?`, `fetchedAt?`, `fallbackReason?`, `revision` (semente do exemplo),
`refresh()`.

Detalhes: a função `load` é guardada em `ref` para não virar laço; `refreshing`
só liga quando já houve um dado antes (primeira carga cai no `Skeleton`); a
releitura automática é um `setInterval` que incrementa `revision`.

### 4.4 Os quatro estados

| Estado | Condição | O que aparece |
| --- | --- | --- |
| **Esperando** | `status === "loading"` sem dado anterior | `Skeleton` do tamanho exato do conteúdo (evita CLS). |
| **Com dado** | `status === "ready"` | O conteúdo, com números contando até o valor lido (`AnimatedNumber`). |
| **Atualizando** | `refreshing === true` | O dado anterior, com "atualizando…" no `DataStatus`. |
| **Sem leitura** | `status === "error"` | `Alert tone="critical"` explicando a falha, com a ação de atualizar. |

Padrão nas `*-view.tsx`:

```tsx
{resource.status === "error" ? (
  <Alert tone="critical" title="Não foi possível ler a telemetria">
    {resource.error} Tente atualizar em alguns instantes.
  </Alert>
) : null}

{data ? <Conteudo {...data} /> : <ConteudoSkeleton />}
```

### 4.5 `*-resource.ts` e `*-data.ts`

**`<rota>-data.ts`** — tipos do dado que a tela desenha; rótulos e mapas de
metadados (`PERIOD_LABELS`, `URGENCY_META`, `SORT_LABELS`…); opções de filtro; o
**conjunto de exemplo** com valores **numéricos** (é a tela que formata, e é isso
que permite animar a contagem); funções puras de apoio (`sortIncidents`,
`aggregateKpis`).

**`<rota>-resource.ts`** — um tipo `*Response` por endpoint (deixa o formato do
backend explícito); uma função `fetch*` por bloco chamando `loadResource`. O
`fallback` costuma aplicar `jitter` nas medições que oscilam e deixar intactos os
campos que **identificam** o registro (id, nome da fonte, cobertura).

### 4.6 `DataStatus`: procedência visível

`components/dashboard/data-status.tsx` diz três coisas em texto:

| Situação | Selo |
| --- | --- |
| `error` | `Leitura falhou` (crítico, `role="status"`) |
| `source === "api"` | `Telemetria ao vivo` (sucesso) |
| `source === "exemplo"` | `Dados de exemplo` (atenção) |
| sem `source` ainda | `Lendo telemetria` (neutro) |

Mais o rótulo "atualizado há X" (recalculado a cada 15 s) e o botão de atualizar.
`showSource={false}` esconde o selo onde o cabeçalho já identifica o incidente —
a falha de leitura continua sendo anunciada. **Um número na tela nunca se
apresenta como medição quando não é.**

### 4.7 Ligar o backend / criar um recurso

Para ligar: preencha `NEXT_PUBLIC_API_BASE_URL`; em cada `*-resource.ts` confira
`path` e escreva o `map` com o formato real da resposta. Nenhum componente muda.

Para criar um recurso: (1) declare o tipo e um exemplo numérico em
`<rota>-data.ts`; (2) escreva `fetchX(query, revision = 0)` com `loadResource` em
`<rota>-resource.ts`; (3) consuma com `useResource` na `*-view.tsx`; (4) desenhe
os quatro estados; (5) ponha `<DataStatus>` no `PageHeader`.

---

## 5. Telas

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
domínio é `@globo.com`, a tela sugere o SSO. Detalhes de rede na seção 9.

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

## 6. Catálogo de componentes

Os de `components/ui` são a biblioteca base e trazem exemplo no próprio arquivo.

### 6.1 `ui/`

**`Button`** (`button.tsx` + `button-classes.ts`) — toda ação usa este componente.

| Prop | Valores | Observação |
| --- | --- | --- |
| `variant` | `gradient` (padrão), `solid`, `outline`, `ghost`, `quiet`, `danger` | `gradient` = ação primária, uma por área. `solid` = navegação/confirmação. `danger` = destrói (fica em contorno). |
| `size` | `sm`, `md` (padrão), `lg` | Alturas `40 / 48 / 51 px`. |
| `fullWidth` | boolean | Ocupa toda a largura. |
| `loading` | boolean | Mostra `SpinnerIcon`, mantém o rótulo, seta `aria-busy`, desabilita. |
| `leadingIcon` / `trailingIcon` | `ReactNode` | O trailing some enquanto `loading`. |

`buttonClasses({ variant, size, fullWidth, className })` devolve só as classes,
sem `"use client"` — para dar aparência de botão a um `<Link>` em Server
Component.

**Campos** (`input.tsx`):

| Export | Uso |
| --- | --- |
| `TextField` | **Forma recomendada.** Cuida de rótulo (`htmlFor`), apoio, erro e `aria-describedby`/`aria-invalid`. Props: `label`, `hint`, `error`, `labelAction`, `fieldSize`. |
| `PasswordField` | Como `TextField`, com alternância mostrar/ocultar (o botão anuncia a ação, não o estado). |
| `SearchInput` | Campo de busca com a lupa embutida. `fieldSize` padrão `sm`. |
| `Input` | Campo cru, sem rótulo. Prefira `TextField`. |
| `Label`, `FieldHint`, `FieldError` | Primitivos, para composições fora do padrão. |

`FieldSize`: `sm | md | lg` → `44 / 51 / 64 px`. `FIELD_SIZE_CLASSES` é
compartilhada com `Select`.

**`Select`** (`select.tsx`) — listbox escrito à mão (não `<select>` nativo),
controlado por `value` / `onValueChange` / `options` (`{ value, label, hint?,
disabled? }[]`). `aria-label` **obrigatório**. Teclado completo (setas, Home, End,
Enter, Espaço, Esc, digitação para pular até a opção); papéis `combobox`/
`listbox`, `aria-activedescendant`. A lista abre em **portal** no `document.body`
(dentro do cartão seria cortada pelo `overflow`), posicionada em coordenadas de
viewport, abrindo para cima quando falta espaço. **Não guarda valor**: quem
decide é a tela.

**`Card`** (`card.tsx`) — `Card`, `CardTitle` (`<h3>`), `CardDescription` (`<p>`).
`accent`: `none` (padrão), `critical`, `warning`, `info`, `brand`;
`accentPosition`: `left` (padrão), `top`; `borderTone`: `line` (padrão),
`critical` (zona de risco); `padding`: `none`, `sm`, `md` (padrão), `lg`.

**`Badge`** (`badge.tsx`) — selo de estado. **Texto obrigatório**. `tone`:
`critical`, `warning`, `success`, `info`, `neutral`, `brand`. `withDot`: ponto
colorido antes do texto. Fundo `-soft`, texto `-strong` (contraste AA); `brand`
usa o gradiente.

**`Alert`** (`alert.tsx`) — aviso de bloco com ícone + texto. `tone`: `critical`,
`warning`, `success`, `info`. `critical` usa `role="alert"` (interrompe a
leitura); os demais, `role="status"`. `title` opcional.

**`Switch`** (`switch.tsx`) — alternância binária de **efeito imediato**.
`role="switch"`, `aria-checked`. Props: `checked`, `onCheckedChange`, `label`
(rótulo acessível), `disabled`.

**`Avatar`** (`avatar.tsx`) — retrato da pessoa em sessão. Lê do
`AccountProvider`: foto quando existe, senão as **iniciais** do nome sobre o
gradiente. `size`: `sm | md | lg` (`32 / 40 / 64 px`).

**`Skeleton`** (`skeleton.tsx`) — `Skeleton` e `SkeletonText` (`lines`). Ocupa
exatamente o tamanho do conteúdo que vem (evita CLS). Brilho contínuo.

**Marca** (`logo.tsx` + `wordmark.tsx`):

| Export | Peça |
| --- | --- |
| `LogoMark` | Símbolo (estrela de quatro pontas sobre elipse navy). `tone`: `brand`, `gradient`, `mono`. **Não acompanha o tema** — cores fixas do manual. |
| `Wordmark` | Letreiro em SVG, vetorizado do arquivo do design. Herda a cor por `currentColor`; a estrela do "O" é recorte de máscara. Entrada em cascata opcional. |
| `Logo` | Composição de símbolo + letreiro (`withWordmark`). |

**`icons.tsx`** — conjunto mínimo de ícones SVG inline (`viewBox 0 0 24 24`),
herdando cor por `currentColor` e tamanho pela prop `size`. Sem dependência
externa. Decorativos recebem `aria-hidden`.

### 6.2 `shell/`

| Componente | Papel |
| --- | --- |
| `AppShell` | `"use client"`. Reúne `Sidebar` + `Topbar` + `<main>`. Guarda o estado da navegação recolhida (persistido, `useSyncExternalStore`), fecha a folha sobreposta no `Esc` e ao navegar. `useMediaQuery` define quando a navegação cabe ao lado do conteúdo (`min-width: 64rem`). |
| `Sidebar` | Navegação lateral fixa (`lg:sticky`). Recolhida = faixa de ícones; folha sobreposta com véu em telas estreitas. Topo: `LogoMark` + `Wordmark`. Rodapé: link para a conta com `Avatar`. |
| `Topbar` | Barra grudada no topo do conteúdo (`sticky`, `backdrop-blur`). Botão de abrir (mobile) / recolher (desktop) a navegação, `Wordmark` quando a nav está recolhida, `ThemeToggle` e `Avatar` → `/configuracoes`. |

`app/(painel)/sidebar-nav.tsx` (`"use client"`) exporta `NAV_ITEMS` e
`SidebarNav`. Item ativo pela rota (`usePathname`). Configurações fecha a lista,
separada por divisória. Recolhida, o rótulo continua no DOM (`sr-only`) e
reaparece como dica no hover.

### 6.3 `dashboard/`

| Componente | Papel |
| --- | --- |
| `PageHeader` | Abertura padrão de tela: `eyebrow`, `title` (`<h1>`), `subtitle`, `status`, `actions`. Entra sempre com o mesmo movimento. |
| `DataStatus` | Procedência + frescor + botão de atualizar (seção 4.6). |
| `FilterBar` | Barra de recorte da Visão Geral (busca + 4 selects). Não guarda estado. `DEFAULT_DASHBOARD_FILTERS` é o recorte do protótipo. |
| `StatCard` (+ skeleton) | Cartão de indicador. Valor com `AnimatedNumber`, formato `integer`/`compact`, `delta` em texto, `accent` `critical`/`warning`/`info`. |
| `ExperienceHealthCard` (+ skeleton) | "Saúde da experiência": `TimeSeriesChart` com `baseline`, `highlight` e pico anotado. O `Select` de período espelha o filtro da tela. |
| `IncidentsCard` (+ skeleton) | Lista curta priorizada por impacto + link para `/incidentes`. |
| `IncidentRow` | Linha da lista curta: título, sessões · tempo, `Badge withDot`. |

### 6.4 `motion/`

**`Reveal`** (`reveal.tsx`) — único mecanismo de entrada de conteúdo. Revela o
bloco quando ele chega à área visível (`IntersectionObserver`, `threshold:
0.01`). `as` (tag; `div` padrão), `variant` (`rise` padrão, `rise-sm`, `fade`,
`scale`, `slide`), `delay` (ms, prioridade sobre `index`), `index` (→
`index * 70ms`). Sem `IntersectionObserver` ou sem JS, mostra tudo de uma vez.

**`AnimatedNumber`** (`animated-number.tsx`) — conta do **valor anterior** até o
atual (não do zero) em 900 ms, com `easeOutCubic`. Respeita `useReducedMotion`. O
valor final fica em `aria-label`. Props: `value`, `format`, `prefix`, `suffix`.

### 6.5 `theme/`

| Componente | Papel |
| --- | --- |
| `ThemeProvider` | `"use client"`. Expõe `useTheme()` → `{ preference, theme, setPreference, toggle }`. Lê a preferência da loja e o gosto do SO por media query; o único efeito escreve `data-theme` no `<html>`. O tema inicial já chega resolvido pelo script do `layout.tsx`. |
| `ThemeToggle` | Botão do topo: troca claro ⇄ escuro. O rótulo anuncia a ação ("Ativar tema escuro"), não o estado. |
| `ThemeChoice` | Controle completo com a terceira opção (acompanhar o sistema); exibido no guia `/design-system`. |

### 6.6 `account/`

`AccountProvider` (`account-provider.tsx`, `"use client"`) expõe `useAccount()` →
`{ profile, updateProfile, reset }`. `profile` = `ACCOUNT_PROFILE` +
`{ name, photo }` editáveis. Persistido em `localStorage` (`createPersistedJson`,
chave `view-show:account`). Lido pela navegação, pela barra superior, pelo
`Avatar` e pela assinatura de quem confirma/refuta uma hipótese em Evidências.

### 6.7 `settings/`

| Componente | Comportamento |
| --- | --- |
| `ProfileCard` | Foto de perfil. Vale na hora, sem salvar. Valida tipo (JPEG/PNG/WebP) e tamanho (≤ 8 MB) via `lib/image.ts`; corta em quadrado e reduz a 320 px no navegador. |
| `AccountDetailsCard` | Nome (editável, **só vale ao salvar** — assina registros), time e fuso (`Select`). `Alert` de confirmação ao salvar. |
| `NotificationsCard` | `Switch` por item de `NOTIFICATION_PREFERENCES`; estado local em `Set`. |
| `AccessSecurityCard` | Método de entrada e sessões ativas, de `ACCOUNT_PROFILE`. Estático. |
| `DangerZoneCard` | Excluir conta. `Card borderTone="critical"`, `Button variant="danger"`. Estático. |

### 6.8 `inline-script.tsx`

`<InlineScript html={...} />` — renderiza um `<script>` síncrono executável no
servidor e inerte no cliente (o React não reexecuta scripts que insere). Usado no
`<head>` do `layout.tsx` para o `THEME_BOOTSTRAP_SCRIPT`.

### 6.9 Regras de composição

- **Uma ação primária por área de decisão.** O gradiente marca a principal; o
  azul sólido, navegação e confirmação; contorno e texto, alternativas;
  `danger`, o que destrói.
- **Rótulo sempre visível acima do campo.** Placeholder é exemplo, não rótulo.
- **Erro abaixo do campo, em texto.** A borda vermelha reforça, não substitui.
- **Seletor é controlado pela tela.** `Select` não guarda valor.
- **Falta uma variante?** Acrescente no arquivo do componente — `cn` (`lib/cn.ts`)
  **não** resolve conflitos de utilitário do Tailwind.
- **Toda adição entra também em `/design-system`.**

---

## 7. Gráficos

Os cinco gráficos do painel saem de dois componentes em `components/charts/`:
`TimeSeriesChart` para séries no tempo e `BarChart` para faixas discretas.

| Gráfico da tela | Componente base | Arquivo |
| --- | --- | --- |
| Saúde da experiência (Visão Geral) | `TimeSeriesChart` | `components/dashboard/experience-health-card.tsx` |
| Buffering após a 4.2.1 (Evidências) | `TimeSeriesChart` | `app/(painel)/evidencias/buffering-chart.tsx` |
| Volume temporal dos eventos (Eventos) | `TimeSeriesChart` | `app/(painel)/eventos/events-chart.tsx` |
| Fluxo de processamento (Monitoramento) | `TimeSeriesChart` | `app/(painel)/monitoramento/processing-flow-chart.tsx` |
| Dispositivos afetados por horário (Incidentes) | `BarChart` | `app/(painel)/incidentes/incidents-chart.tsx` |

O mapa de concentração (`geographic-map.tsx`) é um SVG próprio.

### 7.1 Decisões que valem para todos

| Decisão | Por quê |
| --- | --- |
| **Desenho em pixels reais**, medindo o contêiner (`useElementSize`) | Um `viewBox` esticado por `preserveAspectRatio="none"` serve a qualquer largura, mas distorce rótulos e espessura do traço. |
| **Teto do eixo em marca redonda** (`niceMax`) | Um eixo que termina em 24.837 obriga a ler o número; terminando em 25 mil, a altura já diz. |
| **Grade só na horizontal** | A vertical competiria com o traço da série. |
| **Rótulos do eixo espaçados pela largura** (`labelStep`) | Rótulos que se tocam viram uma faixa cinza ilegível. |
| **Valor exato no cursor, não sobre o desenho** | Espalhar números por cima da curva transforma o gráfico numa tabela mal formatada. |
| **Números tabulares** em eixos, balões e indicadores | Um valor que sobe de 99 para 100 não pode empurrar o que está ao lado. |
| **Anotação em vez de enfeite** | O pico ganha ponto e rótulo discretos; um deploy entra como linha tracejada com nome. |

### 7.2 `scales.ts`

| Função | O que faz |
| --- | --- |
| `toPlot(width, height, margin)` | Área útil do desenho → `{ left, right, top, bottom, width, height }`. |
| `niceMax(value)` | Arredonda o teto para a próxima marca redonda. `niceMax(24837) → 25000`. |
| `axisTicks(max, count = 4)` | Marcas do eixo vertical. `axisTicks(400) → [0,100,200,300,400]`. |
| `labelStep(total, width, minGap = 52)` | Passo entre rótulos do eixo horizontal. |
| `toLinePath(points)` / `toAreaPath(points, baseline)` | Caminho da linha / linha fechada na base para o preenchimento de área. |

### 7.3 `TimeSeriesChart`

`"use client"`. Props: `labels` (um por ponto), `series` (`ChartSeries[]` =
`{ id, label, values, tone, area?, dashed? }`), `formatValue`, `height` (220),
`max`, `reference` (`{ value, label }` — linha da meta), `marker`
(`{ index, label }` — marco vertical), `highlight` (`[ini, fim]` — faixa de
fundo), `showPeak`, `tooltipNote`, `ariaLabel` **obrigatório**.

Comportamento: a linha é **escrita da esquerda para a direita** (`--animate-draw`,
~1,15 s, `pathLength={1}`); séries `dashed` não animam o traço; a área sob a linha
entra por `fade-in`; o pico ganha ponto e valor com `--animate-pop`; o cursor
(`onPointerMove`) acha o ponto mais próximo, desenha a linha-guia e abre o
`ChartTooltip`. `ChartLegend` repete o significado das séries em texto.

### 7.4 `BarChart`

`"use client"`. Para comparar blocos discretos. Props: `bars` (`Bar[]` =
`{ label, value, tone, toneLabel }`), `formatValue`, `valueLabel`, `height` (220),
`ariaLabel` **obrigatório**. Cada barra ocupa dois terços da faixa
(`BAR_FILL = 0.66`, largura máx. `56 px`); as barras **crescem da base** a cada
leitura (`.bar-grow`, chave `${label}-${value}` reconstrói em vez de deslizar); as
não-focadas caem para `opacity-45` quando o cursor está sobre uma.

### 7.5 `ChartTooltip`

Segue o eixo horizontal do ponto lido, se vira ao chegar na borda
(`containerWidth`) e nunca cobre o ponto. É **`aria-hidden`** — a descrição
textual fica no `ariaLabel` do gráfico.

### 7.6 Cores e legenda

Cores de série vêm dos **tokens de estado**, nunca de uma paleta própria:
`critical` (o que degrada), `info` → `brand-blue-light` (etapa de entrada),
`warning`/`brand` → `brand-orange` (comparação, meta), `muted` → `ink-subtle`
(apoio). A legenda repete o significado em texto.

### 7.7 Como adicionar um gráfico

Escolha o base (série no tempo → `TimeSeriesChart`; faixas → `BarChart`); envolva
num `Card` com `CardTitle`/`CardDescription` e, se houver janela, um `Select`
controlado pela tela; passe `series`/`bars` já no formato do componente,
`formatValue` de `lib/format.ts` e um `ariaLabel` que descreva começo, pico e fim;
não invente escala nem cor.

---

## 8. Tema e preferências persistidas

### 8.1 As três preferências

`ThemePreference` (`lib/theme.ts`): `"light" | "dark" | "system"`. O padrão de
quem nunca escolheu é `"system"`. O que chega ao documento é sempre **um dos
dois** temas efetivos, no atributo `data-theme` do `<html>` — é ele que troca os
tokens semânticos em `app/globals.css`.

```ts
resolveTheme("system", true);  // "dark"  (SO pedindo escuro)
resolveTheme("light", true);   // "light" (escolha explícita ganha do SO)
```

### 8.2 O ciclo do tema

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

### 8.3 O script de bootstrap

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

### 8.4 `persisted-preference.ts`

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

### 8.5 `useMediaQuery` e `useReducedMotion`

`hooks/use-media-query.ts` lê uma media query com `useSyncExternalStore`; **no
servidor devolve sempre `false`**. `hooks/use-reduced-motion.ts` é um atalho de
`useMediaQuery("(prefers-reduced-motion: reduce)")`, usado pelo movimento escrito
em JS (`AnimatedNumber`, o traço das séries). O CSS já respeita
`prefers-reduced-motion` sozinho.

### 8.6 O tema escuro no CSS

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

### 8.7 Onde a pessoa troca

- **Troca rápida** (claro ⇄ escuro): `ThemeToggle`, botão da barra superior.
- **Escolha completa** (com "acompanhar o sistema"): `ThemeChoice`, no guia
  `/design-system`. A tela de Configurações **não** tem controle de aparência.

---

## 9. Autenticação e conta

O View Show não guarda senha nem valida credencial: a autenticação é delegada ao
serviço de identidade (RIE01, RESTR01).

### 9.1 `lib/auth.ts`

| Export | Assinatura | Papel |
| --- | --- | --- |
| `CORPORATE_DOMAINS` | `["globo.com"]` | Domínios corporativos, para o exemplo de preenchimento e o SSO. |
| `isCorporateEmail(email)` | `→ boolean` | Reconhece a conta corporativa para **sugerir** o SSO. Não restringe a entrada. |
| `validateEmail(email)` | `→ string \| undefined` | Formato mínimo: algo `@` domínio com ponto, sem espaços. |
| `validatePassword(password)` | `→ string \| undefined` | Só verifica preenchimento. |
| `signIn({ email, password })` | `→ Promise<SignInResult>` | Envia as credenciais. |
| `ssoEntryPoint()` | `→ string \| undefined` | URL do fluxo de SSO, ou `undefined` sem API configurada. |
| `AUTH_UNAVAILABLE_MESSAGE` | `string` | Aviso quando o SSO não está configurado. |

```ts
type SignInResult =
  | { ok: true; demo?: boolean }        // demo = sessão sem provedor por trás
  | { ok: false; message: string };
```

### 9.2 Fluxo de login

`app/(auth)/login/login-form.tsx` (`"use client"`): `handleSubmit` chama
`preventDefault`, valida os dois campos, leva o foco ao primeiro inválido, então
`await signIn(...)`. `ok: false` → `<Alert tone="critical">` com `result.message`.
`ok: true` → `router.push("/visao-geral")`.

**Com API configurada:**

```
POST {NEXT_PUBLIC_API_BASE_URL}/auth/login
Content-Type: application/json
credentials: "include"        // a sessão volta como cookie assinado —
                              // o token não passa por localStorage
body: { email: <minúsculas, sem espaços>, password }
```

| Resposta | Resultado |
| --- | --- |
| `2xx` | `{ ok: true }` → vai para `/visao-geral` |
| `401` / `403` | "E-mail ou senha incorretos. Verifique e tente novamente." |
| Outro status | "Não foi possível entrar agora. Tente novamente em instantes." |
| Falha de rede | "Não conseguimos falar com o serviço de autenticação. Verifique a sua conexão." |

### 9.3 Sessão de demonstração

**Sem `NEXT_PUBLIC_API_BASE_URL`**, `signIn` devolve `{ ok: true, demo: true }`
sem tocar na rede. Travar o acesso deixaria a plataforma inalcançável num
ambiente sem backend; o painel inteiro funciona com o conjunto de exemplo. Nada é
persistido no navegador por esta camada. A flag `demo` permite à interface dizer
que a sessão não tem provedor de identidade por trás.

### 9.4 SSO Globo

O botão "Entrar com SSO Globo" chama `handleSso()`: `ssoEntryPoint()` devolve
`{API}/auth/sso` quando há API, ou `undefined`. Com URL:
`window.location.assign(ssoUrl)`. Sem URL: mostra `AUTH_UNAVAILABLE_MESSAGE` — a
ação **explica** a indisponibilidade em vez de ficar desabilitada.

### 9.5 Recuperação de senha

`/recuperar-senha` é estática. A senha pertence ao provedor corporativo
(RESTR01). A tela orienta a procurar o suporte interno de TI e volta ao login.

### 9.6 Perfil da conta (`AccountProvider`)

```ts
const { profile, updateProfile, reset } = useAccount();
// profile: AccountProfile & { photo: string | null }
// updateProfile(patch: Partial<{ name: string; photo: string | null }>)
// reset(): volta ao nome do provedor e remove a foto
```

`AccountProfile` (de `lib/settings-data.ts`): `name`, `email`, `role`,
`authMethod`, `lastAccess`, `activeSessions`. Editáveis pela pessoa: **só `name` e
`photo`**. Persistido em `localStorage` via `createPersistedJson` (chave
`view-show:account`). Quando a API de conta existir, `updateProfile` passa a
enviá-la e **nenhuma tela muda**.

| Campo | Quando vale | Onde | Por quê |
| --- | --- | --- | --- |
| **Foto** | Na hora | `ProfileCard` | Escolher a imagem já é a confirmação; trocar/remover desfaz. |
| **Nome** | Só ao salvar | `AccountDetailsCard` | Ele assina registros em Evidências — a alteração passa por confirmação explícita. |

Sem foto, o `Avatar` mostra as **iniciais** do nome sobre o gradiente da marca.

### 9.7 Foto de perfil (`lib/image.ts`)

`readSquareImage(file): Promise<string>` — converte o arquivo num data URL
quadrado e reduzido, **no navegador**, antes de guardar.

| Constante | Valor |
| --- | --- |
| `MAX_SIDE` | `320` px — lado da imagem guardada |
| `MAX_UPLOAD_BYTES` | `8 * 1024 * 1024` (8 MB) — tamanho máximo do original |
| `ACCEPTED_IMAGE_TYPES` | `image/jpeg`, `image/png`, `image/webp` |

Erros (`ImageError`): `tipo-invalido`, `arquivo-grande`, `leitura-falhou`, com
mensagens em `IMAGE_ERROR_MESSAGES`. O corte é **central**. A saída é
`canvas.toDataURL("image/jpeg", 0.85)`.

---

## 10. Design system e movimento

O guia completo de tokens, com valores e critérios de uso, está em
[`docs/design-system.md`](./docs/design-system.md). Resumo do essencial:

### 10.1 Tokens

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

### 10.2 Movimento

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

### 10.3 Contenção visual

O gradiente da marca marca **ação**, não decoração: fica na ação primária, no
item ativo da navegação e no retrato da conta. Saiu das faixas de topo dos
cartões e das barras de proporção, que passaram a usar a cor do estado que
representam. O cartão se separa do fundo pela borda; a sombra apenas assenta a
peça. Cartão não levanta quando o ponteiro passa.

---

## 11. Acessibilidade

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


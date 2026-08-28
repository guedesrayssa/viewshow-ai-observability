# Catálogo de componentes e gráficos

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha `components/`; a visão geral está na seção 6 do índice.

Os de `components/ui` são a biblioteca base e trazem exemplo no próprio arquivo.

## Componentes

### `ui/`

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

### `shell/`

| Componente | Papel |
| --- | --- |
| `AppShell` | `"use client"`. Reúne `Sidebar` + `Topbar` + `<main>`. Guarda o estado da navegação recolhida (persistido, `useSyncExternalStore`), fecha a folha sobreposta no `Esc` e ao navegar. `useMediaQuery` define quando a navegação cabe ao lado do conteúdo (`min-width: 64rem`). |
| `Sidebar` | Navegação lateral fixa (`lg:sticky`). Recolhida = faixa de ícones; folha sobreposta com véu em telas estreitas. Topo: `LogoMark` + `Wordmark`. Rodapé: link para a conta com `Avatar`. |
| `Topbar` | Barra grudada no topo do conteúdo (`sticky`, `backdrop-blur`). Botão de abrir (mobile) / recolher (desktop) a navegação, `Wordmark` quando a nav está recolhida, `ThemeToggle` e `Avatar` → `/configuracoes`. |

`app/(painel)/sidebar-nav.tsx` (`"use client"`) exporta `NAV_ITEMS` e
`SidebarNav`. Item ativo pela rota (`usePathname`). Configurações fecha a lista,
separada por divisória. Recolhida, o rótulo continua no DOM (`sr-only`) e
reaparece como dica no hover.

### `dashboard/`

| Componente | Papel |
| --- | --- |
| `PageHeader` | Abertura padrão de tela: `eyebrow`, `title` (`<h1>`), `subtitle`, `status`, `actions`. Entra sempre com o mesmo movimento. |
| `DataStatus` | Procedência + frescor + botão de atualizar (ver [`camada-de-dados.md`](./camada-de-dados.md#datastatus-procedência-visível)). |
| `FilterBar` | Barra de recorte da Visão Geral (busca + 4 selects). Não guarda estado. `DEFAULT_DASHBOARD_FILTERS` é o recorte do protótipo. |
| `StatCard` (+ skeleton) | Cartão de indicador. Valor com `AnimatedNumber`, formato `integer`/`compact`, `delta` em texto, `accent` `critical`/`warning`/`info`. |
| `ExperienceHealthCard` (+ skeleton) | "Saúde da experiência": `TimeSeriesChart` com `baseline`, `highlight` e pico anotado. O `Select` de período espelha o filtro da tela. |
| `IncidentsCard` (+ skeleton) | Lista curta priorizada por impacto + link para `/incidentes`. |
| `IncidentRow` | Linha da lista curta: título, sessões · tempo, `Badge withDot`. |

### `motion/`

**`Reveal`** (`reveal.tsx`) — único mecanismo de entrada de conteúdo. Revela o
bloco quando ele chega à área visível (`IntersectionObserver`, `threshold:
0.01`). `as` (tag; `div` padrão), `variant` (`rise` padrão, `rise-sm`, `fade`,
`scale`, `slide`), `delay` (ms, prioridade sobre `index`), `index` (→
`index * 70ms`). Sem `IntersectionObserver` ou sem JS, mostra tudo de uma vez.

**`AnimatedNumber`** (`animated-number.tsx`) — conta do **valor anterior** até o
atual (não do zero) em 900 ms, com `easeOutCubic`. Respeita `useReducedMotion`. O
valor final fica em `aria-label`. Props: `value`, `format`, `prefix`, `suffix`.

### `theme/`

| Componente | Papel |
| --- | --- |
| `ThemeProvider` | `"use client"`. Expõe `useTheme()` → `{ preference, theme, setPreference, toggle }`. Lê a preferência da loja e o gosto do SO por media query; o único efeito escreve `data-theme` no `<html>`. O tema inicial já chega resolvido pelo script do `layout.tsx`. |
| `ThemeToggle` | Botão do topo: troca claro ⇄ escuro. O rótulo anuncia a ação ("Ativar tema escuro"), não o estado. |
| `ThemeChoice` | Controle completo com a terceira opção (acompanhar o sistema); exibido no guia `/design-system`. |

Ciclo completo do tema em [`tema.md`](./tema.md).

### `account/`

`AccountProvider` (`account-provider.tsx`, `"use client"`) expõe `useAccount()` →
`{ profile, updateProfile, reset }`. `profile` = `ACCOUNT_PROFILE` +
`{ name, photo }` editáveis. Persistido em `localStorage` (`createPersistedJson`,
chave `view-show:account`). Lido pela navegação, pela barra superior, pelo
`Avatar` e pela assinatura de quem confirma/refuta uma hipótese em Evidências.
Detalhe em [`autenticacao.md`](./autenticacao.md#perfil-da-conta-accountprovider).

### `settings/`

| Componente | Comportamento |
| --- | --- |
| `ProfileCard` | Foto de perfil. Vale na hora, sem salvar. Valida tipo (JPEG/PNG/WebP) e tamanho (≤ 8 MB) via `lib/image.ts`; corta em quadrado e reduz a 320 px no navegador. |
| `AccountDetailsCard` | Nome (editável, **só vale ao salvar** — assina registros), time e fuso (`Select`). `Alert` de confirmação ao salvar. |
| `NotificationsCard` | `Switch` por item de `NOTIFICATION_PREFERENCES`; estado local em `Set`. |
| `AccessSecurityCard` | Método de entrada e sessões ativas, de `ACCOUNT_PROFILE`. Estático. |
| `DangerZoneCard` | Excluir conta. `Card borderTone="critical"`, `Button variant="danger"`. Estático. |

### `inline-script.tsx`

`<InlineScript html={...} />` — renderiza um `<script>` síncrono executável no
servidor e inerte no cliente (o React não reexecuta scripts que insere). Usado no
`<head>` do `layout.tsx` para o `THEME_BOOTSTRAP_SCRIPT`.

### Regras de composição

- **Uma ação primária por área de decisão.** O gradiente marca a principal; o
  azul sólido, navegação e confirmação; contorno e texto, alternativas;
  `danger`, o que destrói.
- **Rótulo sempre visível acima do campo.** Placeholder é exemplo, não rótulo.
- **Erro abaixo do campo, em texto.** A borda vermelha reforça, não substitui.
- **Seletor é controlado pela tela.** `Select` não guarda valor.
- **Falta uma variante?** Acrescente no arquivo do componente — `cn` (`lib/cn.ts`)
  **não** resolve conflitos de utilitário do Tailwind.
- **Toda adição entra também em `/design-system`.**

## Gráficos

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

### Decisões que valem para todos

| Decisão | Por quê |
| --- | --- |
| **Desenho em pixels reais**, medindo o contêiner (`useElementSize`) | Um `viewBox` esticado por `preserveAspectRatio="none"` serve a qualquer largura, mas distorce rótulos e espessura do traço. |
| **Teto do eixo em marca redonda** (`niceMax`) | Um eixo que termina em 24.837 obriga a ler o número; terminando em 25 mil, a altura já diz. |
| **Grade só na horizontal** | A vertical competiria com o traço da série. |
| **Rótulos do eixo espaçados pela largura** (`labelStep`) | Rótulos que se tocam viram uma faixa cinza ilegível. |
| **Valor exato no cursor, não sobre o desenho** | Espalhar números por cima da curva transforma o gráfico numa tabela mal formatada. |
| **Números tabulares** em eixos, balões e indicadores | Um valor que sobe de 99 para 100 não pode empurrar o que está ao lado. |
| **Anotação em vez de enfeite** | O pico ganha ponto e rótulo discretos; um deploy entra como linha tracejada com nome. |

### `scales.ts`

| Função | O que faz |
| --- | --- |
| `toPlot(width, height, margin)` | Área útil do desenho → `{ left, right, top, bottom, width, height }`. |
| `niceMax(value)` | Arredonda o teto para a próxima marca redonda. `niceMax(24837) → 25000`. |
| `axisTicks(max, count = 4)` | Marcas do eixo vertical. `axisTicks(400) → [0,100,200,300,400]`. |
| `labelStep(total, width, minGap = 52)` | Passo entre rótulos do eixo horizontal. |
| `toLinePath(points)` / `toAreaPath(points, baseline)` | Caminho da linha / linha fechada na base para o preenchimento de área. |

### `TimeSeriesChart`

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

### `BarChart`

`"use client"`. Para comparar blocos discretos. Props: `bars` (`Bar[]` =
`{ label, value, tone, toneLabel }`), `formatValue`, `valueLabel`, `height` (220),
`ariaLabel` **obrigatório**. Cada barra ocupa dois terços da faixa
(`BAR_FILL = 0.66`, largura máx. `56 px`); as barras **crescem da base** a cada
leitura (`.bar-grow`, chave `${label}-${value}` reconstrói em vez de deslizar); as
não-focadas caem para `opacity-45` quando o cursor está sobre uma.

### `ChartTooltip`

Segue o eixo horizontal do ponto lido, se vira ao chegar na borda
(`containerWidth`) e nunca cobre o ponto. É **`aria-hidden`** — a descrição
textual fica no `ariaLabel` do gráfico.

### Cores e legenda

Cores de série vêm dos **tokens de estado**, nunca de uma paleta própria:
`critical` (o que degrada), `info` → `brand-blue-light` (etapa de entrada),
`warning`/`brand` → `brand-orange` (comparação, meta), `muted` → `ink-subtle`
(apoio). A legenda repete o significado em texto.

### Como adicionar um gráfico

Escolha o base (série no tempo → `TimeSeriesChart`; faixas → `BarChart`); envolva
num `Card` com `CardTitle`/`CardDescription` e, se houver janela, um `Select`
controlado pela tela; passe `series`/`bars` já no formato do componente,
`formatValue` de `lib/format.ts` e um `ariaLabel` que descreva começo, pico e fim;
não invente escala nem cor.

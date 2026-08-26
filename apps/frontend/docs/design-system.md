# Design system do View Show

> Referência de tokens, componentes e regras de uso da interface. Os valores vêm da
> prancha **Foundations** do [Figma do projeto](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437)
> e estão documentados na seção 7 do [entendimento de UX](../../../artefatos/entendimento_ux.md).

A versão navegável, renderizada com o mesmo código das telas, fica em **`/design-system`**.

## Sumário

- [1. Como usar](#1-como-usar)
- [2. Tokens](#2-tokens)
  - [2.1 Cores de marca](#21-cores-de-marca)
  - [2.2 Superfícies, texto e bordas](#22-superfícies-texto-e-bordas)
  - [2.3 Estados](#23-estados)
  - [2.4 Tipografia](#24-tipografia)
  - [2.4.1 Densidade](#241-densidade)
  - [2.5 Raios, sombras e gradientes](#25-raios-sombras-e-gradientes)
  - [2.6 Movimento](#26-movimento)
- [3. Tema claro e escuro](#3-tema-claro-e-escuro)
- [4. Marca](#4-marca)
- [5. Moldura das telas](#5-moldura-das-telas)
- [6. Conta](#6-conta)
- [7. Dados na tela](#7-dados-na-tela)
- [8. Componentes](#8-componentes)
- [9. Acessibilidade](#9-acessibilidade)
- [10. Como estender](#10-como-estender)

## 1. Como usar

Os tokens ficam em `app/globals.css`, dentro do bloco `@theme` do Tailwind v4. Cada
token vira automaticamente um utilitário: `--color-ink-muted` produz `text-ink-muted`,
`bg-ink-muted` e `border-ink-muted`.

```tsx
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";

<TextField label="E-mail" type="email" placeholder="nome@globo.com" />
<Button variant="gradient" fullWidth>Entrar</Button>
```

Três regras sustentam a consistência entre as telas:

1. **Cor literal só existe em `app/globals.css`.** Nas telas, use o token semântico.
   O nome descreve o papel (`surface`, `ink-muted`, `line`), não a cor. É o que faz o
   tema escuro funcionar sem tocar em componente nenhum: ele reescreve os valores dos
   mesmos tokens.
2. **Elemento interativo vem de `components/ui`.** Botão, campo, cartão, selo e aviso
   já carregam altura, raio, foco, estados e relações de acessibilidade corretas.
3. **Cor nunca comunica sozinha.** Todo estado leva rótulo textual junto, conforme as
   WCAG 2.2 adotadas no projeto.

## 2. Tokens

### 2.1 Cores de marca

| Token | Valor | Uso |
| --- | --- | --- |
| `brand-blue` | `#0D47D9` | Ações de navegação, links e destaques informativos |
| `brand-blue-light` | `#146EF5` | Anel de foco, bordas de destaque, estado "Ativo" |
| `brand-navy` | `#101B46` | Navegação lateral, superfícies escuras, texto de título |
| `brand-orange` | `#FF6A32` | Início do gradiente e estado de atenção |
| `brand-red` | `#F43F4E` | Fim do gradiente, severidade crítica, marca |

Azul e navy sustentam a estrutura. Laranja e vermelho ficam reservados a ações primárias
e a estados de atenção: usados em excesso, deixam de destacar.

### 2.2 Superfícies, texto e bordas

| Token | Valor | Uso |
| --- | --- | --- |
| `canvas` | `#F5F7FB` | Fundo da aplicação |
| `surface` | `#FFFFFF` | Cartões, campos e painéis |
| `surface-muted` | `#F8FAFC` | Faixas alternadas de tabela e áreas internas |
| `surface-inverse` | `#101B46` | Navegação e painéis escuros |
| `ink` | `#171A22` | Texto principal |
| `ink-muted` | `#667085` | Texto de apoio, rótulos de campo |
| `ink-subtle` | `#98A2B3` | Placeholder, legendas, carimbos de tempo |
| `ink-inverse` | `#FFFFFF` | Texto sobre superfícies escuras |
| `line-subtle` | `#F5F7FB` | Divisórias internas |
| `line` | `#E6EAF0` | Borda padrão de cartões e campos |
| `line-strong` | `#D0D5DD` | Borda de ênfase e estado hover |

### 2.3 Estados

| Token | Valor | Rótulo típico |
| --- | --- | --- |
| `critical` | `#F43F4E` | Crítico, P1, erro de formulário |
| `warning` | `#FFB020` | Atenção, fonte atrasada |
| `info` | `#146EF5` | Ativo, em investigação |
| `success` | `#22A06B` | Estável, dentro da meta |

Cada estado tem duas variantes de apoio:

- `-soft` (`critical-soft`, `warning-soft`, `success-soft`, `info-soft`) é o fundo de
  selos e avisos;
- `-strong` (`critical-strong`, `warning-strong`, `success-strong`) é a cor do **texto**.

A separação existe porque a cor cheia da marca não alcança a relação de contraste de
4,5:1 exigida pelas WCAG 2.2 em textos pequenos: `critical` sobre branco fica em 3,7:1,
enquanto `critical-strong` chega a 5,8:1. A cor cheia continua identificando o estado em
pontos, faixas laterais e bordas, onde o critério aplicável é o de 3:1 para elementos
não textuais.

### 2.4 Tipografia

Poppins em quatro pesos: Regular (400), Medium (500), SemiBold (600) e Bold (700),
carregada por `next/font` e hospedada junto da aplicação.

Cada token de tamanho já embute entrelinha, peso e tracking, então `text-h1` basta para
um título.

| Token | Tamanho / entrelinha | Peso | Uso |
| --- | --- | --- | --- |
| `text-display` | 32 / 40 | 700 | Título de abertura |
| `text-h1` | 26 / 34 | 700 | Título de tela |
| `text-h2` | 20 / 28 | 600 | Título de seção |
| `text-h3` | 17 / 24 | 600 | Título de bloco e valor de KPI |
| `text-title` | 15 / 22 | 600 | Título de cartão |
| `text-body` | 14 / 22 | 400 | Texto padrão e conteúdo de campo |
| `text-body-sm` | 13 / 20 | 400 | Texto de apoio e rótulo de botão |
| `text-label` | 12 / 18 | 500 | Rótulo de campo |
| `text-caption` | 11 / 16 | 400 | Legenda, selo, comparação com a base |
| `text-micro` | 10 / 14 | 400 | Nota de rodapé e detalhe de mapa |

### 2.4.1 Densidade

A unidade de espaçamento do Tailwind é `--spacing: 0.2rem`, contra os 0,25rem padrão.
Como todo `p-4`, `gap-6` e `h-11` deriva dela, mudar esse número reescala a interface
inteira: é a densidade de quem trabalha com o navegador em 80%, com mais dado por tela.

Os títulos encolheram mais do que o texto corrido — em um painel, é o título que ocupa
espaço sem carregar dado. As alturas de campo e de botão encolheram menos do que a
escala, porque continuam sendo alvo de clique e de toque:

| Elemento | `sm` | `md` | `lg` |
| --- | --- | --- | --- |
| Campo e seletor | 35 px | 42 px | 51 px |
| Botão | 32 px | 38 px | 42 px |

### 2.5 Raios, sombras e gradientes

| Token | Valor | Uso |
| --- | --- | --- |
| `rounded-field` | 10 px | Campos, botões e avisos |
| `rounded-card` | 14 px | Cartões e painéis |
| `rounded-panel` | 20 px | Contêineres maiores |
| `rounded-pill` | circular | Selos, pontos de estado e avatares |
| `shadow-card` | discreta | Separa o cartão do fundo sem borda pesada |
| `shadow-raised` | média | Menus, popovers e elementos flutuantes |
| `shadow-brand` | quente | Exclusiva do botão em gradiente |
| `bg-gradient-brand` | laranja para vermelho | Ação primária e destaques |
| `bg-gradient-navy` | navy | Painéis institucionais escuros |
| `bg-gradient-orb` | laranja para roxo | Esferas decorativas do login |

### 2.6 Movimento

O movimento também é token. Os tempos e as curvas ficam em `@theme`, e cada utilitário
`animate-*` traz duração e curva prontas, para que duas telas não inventem ritmos
próprios.

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

Duas curvas dão o caráter: `--ease-out-quint` para entradas, que chegam rápido e
assentam; `--ease-in-out-quart` para percursos, como o traço de uma série.

Regras de uso:

- **O movimento tem que dizer algo.** A barra cresce porque a altura é o dado; a linha é
  escrita porque o eixo é o tempo; o número conta porque acabou de ser lido. Movimento
  que não carrega informação não entra.
- **Entrada é uma coisa só.** Todo conteúdo entra por `<Reveal>`
  (`components/motion/reveal.tsx`), que revela o bloco quando ele chega à tela e monta a
  cascata pelo `index`. O passo padrão é 70 ms.
- **Número que muda usa `<AnimatedNumber>`**, que conta do valor anterior até o atual —
  não do zero. É o tamanho do salto que informa.
- **Nada disso é condição para ler a tela.** Sem JavaScript o conteúdo aparece inteiro;
  com `prefers-reduced-motion: reduce`, todas as durações caem para 0,01 ms.

## 3. Tema claro e escuro

O tema escuro é azul-noite, derivado do navy da marca. Ele reescreve apenas os tokens
semânticos, no bloco `:root[data-theme="dark"]` de `app/globals.css` — nenhum componente
usa a variante `dark:` do Tailwind, porque quem escreve `bg-surface` já acompanha o tema.

| Token | Claro | Escuro |
| --- | --- | --- |
| `canvas` | `#F5F7FB` | `#060C22` |
| `surface` | `#FFFFFF` | `#0D1633` |
| `surface-muted` | `#F8FAFC` | `#131E42` |
| `ink` | `#171A22` | `#EEF3FF` |
| `ink-muted` | `#667085` | `#A3B4DB` |
| `ink-brand` | `#0D47D9` | `#8FB3FF` |
| `line` | `#E6EAF0` | `#223059` |
| `critical-strong` | `#C4232F` | `#FF9AA2` |

Os tokens de marca não mudam: o gradiente laranja, o símbolo e a identidade são os
mesmos nos dois temas.

**`ink-brand` é o azul de texto.** Textos secundários azuis usam `text-ink-brand`;
`brand-blue` fica reservado a preenchimento (`bg-brand-blue`). A separação existe porque
um azul que funciona como fundo no claro não tem contraste como texto no escuro.

A preferência tem três valores — claro, escuro e sistema — e é resolvida antes da
primeira pintura por um script inline no `<head>` (`THEME_BOOTSTRAP_SCRIPT`, em
`lib/theme.ts`). Sem ele, recarregar no escuro pisca branco. A troca rápida fica na barra
superior; a escolha completa, em Configurações.

## 4. Marca

O logotipo textual é o SVG entregue pelo design, em `components/ui/wordmark.tsx`, e não
a palavra "View Show" composta em Poppins. O desenho herda a cor do texto por
`currentColor`, e a estrela do "O" é um recorte de máscara — ela deixa passar o fundo em
vez de carregar uma cor própria, o que faz a mesma peça servir ao claro, ao escuro e ao
navy da navegação.

| Peça | Componente | Onde |
| --- | --- | --- |
| Símbolo | `LogoMark` | Login, recuperação de senha, topo da navegação |
| Letreiro | `Wordmark` | Ao lado do símbolo, e sozinho na barra superior |
| Marca completa | `Logo` | Composição das duas, com `withWordmark` |

O símbolo não acompanha o tema: a elipse navy e o brilho branco de quatro pontas são
cores fixas do manual, e não tokens de superfície. Amarrá-los a `surface` fazia o brilho
desaparecer dentro da elipse no tema escuro — justamente o elemento que dá nome à
marca.

## 5. Moldura das telas

Toda tela autenticada é montada em `components/shell/app-shell.tsx`:

- **Navegação lateral fixa.** Não rola com a página; rola só o conteúdo. Tem dois
  tamanhos no computador — aberta, com rótulos, e recolhida, só com ícones — e vira uma
  folha sobreposta em telas estreitas. Configurações é o último item da lista, separado
  por uma divisória: é ajuste de conta, não etapa da investigação.
- **Um botão para recolher.** Ele fica na barra superior. A barra lateral só tem o botão
  de fechar da folha sobreposta, que existe porque em telas de toque não há barra
  superior visível por trás dela. A escolha fica guardada entre as sessões, e recolher
  só existe no computador.
- **Barra superior grudada no topo.** Concentra o que não pertence a nenhuma tela:
  recolher a navegação, trocar a aparência e chegar à conta.
- **Cabeçalho de tela padrão.** `PageHeader` (`components/dashboard/page-header.tsx`)
  entrega contexto, título, subtítulo, procedência do dado e as ações específicas da
  tela, sempre na mesma ordem.

## 6. Conta

Nome e foto ficam em `components/account/account-provider.tsx` e valem para toda a
interface: a navegação, a barra superior e a assinatura de quem confirma uma hipótese
leem do mesmo lugar. Enquanto a API de conta não existe, a alteração fica guardada no
navegador; quando existir, `updateProfile` passa a enviá-la e nenhuma tela muda.

As duas alterações têm ritmos diferentes, de propósito:

- **A foto vale na hora.** Escolher a imagem já é a confirmação, e trocar ou remover
  desfaz. O arquivo é cortado em quadrado e reduzido a 320 px no navegador antes de ser
  guardado — o maior lugar onde ele aparece tem 64 px de lado.
- **O nome só vale ao salvar.** É ele que assina registros em Evidências, então a
  alteração passa por uma confirmação explícita.

Sem foto, o `Avatar` mostra as iniciais do nome sobre o gradiente da marca: identifica
quem está na sessão melhor do que um símbolo genérico de pessoa.

## 7. Dados na tela

Nenhum número exibido vem direto de um módulo de exemplo. Toda medição passa por
`lib/data/client.ts`, que decide entre a API de telemetria e o conjunto de exemplo, e
chega ao componente pelo hook `useResource` (`hooks/use-resource.ts`). Os módulos
`*-data.ts` guardam os tipos, os rótulos e as opções de filtro — e o conjunto de exemplo
que o recurso usa como reserva.

```tsx
const incidents = useResource(
  (revision) => fetchIncidents(query, revision),
  [period, deviceType],
  { refreshMs: 45_000 },
);
```

Cada tela declara o endpoint que vai servi-la (`lib/data/endpoints.ts`, espelhando as
rotas de `apps/basica/backend`), como converter a resposta e o que mostrar enquanto a
API não responde. Ligar o backend é preencher `NEXT_PUBLIC_API_BASE_URL` e escrever o
`map` — nenhum componente muda.

Os quatro estados são obrigatórios na tela:

| Estado | O que aparece |
| --- | --- |
| Esperando | `Skeleton` do tamanho exato do conteúdo que vem |
| Com dado | O conteúdo, com números contando até o valor lido |
| Atualizando | O dado anterior, com "atualizando..." no `DataStatus` |
| Sem leitura | `Alert` explicando a falha, com a ação de atualizar disponível |

**A procedência fica visível.** `DataStatus` mostra em texto se o número veio da
telemetria ("Telemetria ao vivo") ou do conjunto de exemplo ("Dados de exemplo"), e há
quanto tempo foi lido. Um número na tela nunca se apresenta como medição quando não é.

## 8. Componentes

Todos ficam em `components/ui` e são documentados com exemplo no próprio arquivo.

| Componente | Arquivo | Variantes |
| --- | --- | --- |
| `Button` | `button.tsx` | `gradient`, `solid`, `outline`, `ghost`, `quiet`, `danger`; tamanhos `sm`, `md`, `lg`; estados `loading` e `disabled`. A aparência sozinha, para um `Link`, vem de `buttonClasses` (`button-classes.ts`) |
| `TextField`, `PasswordField` | `input.tsx` | Alturas `sm`, `md`, `lg`; rótulo, apoio e erro já conectados |
| `SearchInput` | `input.tsx` | Campo de busca das barras de filtro, com lupa embutida |
| `Select` | `select.tsx` | Listbox próprio, controlado por `value`/`onValueChange`/`options`; opções com texto de apoio e estado desabilitado |
| `Input`, `Label`, `FieldHint`, `FieldError` | `input.tsx` | Primitivos, para composições fora do padrão |
| `Card`, `CardTitle`, `CardDescription` | `card.tsx` | Faixa de destaque `critical`, `warning`, `info`, `brand`, à esquerda ou no topo; borda `critical` para zona de risco |
| `Badge` | `badge.tsx` | `critical`, `warning`, `success`, `info`, `neutral`, `brand`, com ou sem ponto |
| `Alert` | `alert.tsx` | `critical`, `warning`, `success`, `info` |
| `Switch` | `switch.tsx` | Alternância ligado/desligado, para preferências de efeito imediato |
| `Avatar` | `avatar.tsx` | Retrato de espaço reservado, tamanhos `md` e `lg` |
| `Logo`, `LogoMark` | `logo.tsx` | Aplicações `brand`, `gradient` e `mono` do manual |
| `Wordmark` | `wordmark.tsx` | Letreiro da marca em SVG, com entrada em cascata opcional |
| `Skeleton`, `SkeletonText` | `skeleton.tsx` | Espaço reservado durante a leitura |
| `Reveal` | `motion/reveal.tsx` | Entrada de conteúdo: `rise`, `rise-sm`, `fade`, `scale`, `slide` |
| `AnimatedNumber` | `motion/animated-number.tsx` | Número que conta do valor anterior até o atual |
| `ThemeToggle`, `ThemeChoice` | `theme/theme-toggle.tsx` | Troca rápida de tema e escolha completa |
| `DataStatus` | `dashboard/data-status.tsx` | Procedência, frescor e ação de atualizar |
| Ícones | `icons.tsx` | Conjunto mínimo em SVG inline, sem dependência externa |

Regras de composição:

- **Uma ação primária por área de decisão.** O gradiente marca a ação principal; o azul
  sólido, ações de navegação e confirmação; contorno e texto, alternativas; `danger`, o
  que destrói.
- **Rótulo sempre visível acima do campo.** Placeholder é exemplo de preenchimento, não
  substitui rótulo.
- **Erro abaixo do campo, em texto.** A borda vermelha reforça, mas não é o único sinal.
- **Seletor é controlado.** `Select` não guarda valor: quem decide é a tela, porque é
  ela que refaz a leitura da telemetria quando o filtro muda.

O `Select` é escrito à mão em vez de usar `<select>`: a lista aberta do nativo é
desenhada pelo sistema operacional e não aceita o tipo, o raio nem as cores do produto —
no tema escuro, chegava a abrir clara. O custo é implementar o teclado (setas, Home,
End, Enter, Espaço, Esc e digitação para pular até a opção) e os papéis
`combobox`/`listbox` da WAI-ARIA, que estão no componente. A lista abre em um portal no
fim do documento, porque dentro do cartão ela seria cortada pelo `overflow`.

## 9. Acessibilidade

- Contraste: `ink` sobre `surface` alcança 17,4:1 e `ink-muted` sobre `surface`, 5,0:1,
  ambos acima do mínimo AA para texto (4,5:1). Sobre `canvas`, `ink-muted` fica em 4,6:1.
- Foco: anel de 2 px em `brand-blue-light` com deslocamento de 2 px em todo elemento
  interativo, atendendo ao critério 2.4.11 das WCAG 2.2.
- Formulários: rótulo associado por `htmlFor`, `aria-invalid` no campo com erro e
  `aria-describedby` apontando para a mensagem em vigor.
- Erros de envio aparecem em um `Alert` com `role="alert"`, anunciado assim que surge, e
  o foco vai para o primeiro campo inválido.
- Ilustrações decorativas, como o painel do login, ficam com `aria-hidden`.
- Toda animação respeita `prefers-reduced-motion`, inclusive a contagem de números e o
  desenho das séries, que são escritos em JavaScript.
- Conteúdo que entra por animação só é escondido quando há JavaScript: sem ele, a página
  aparece inteira.
- No tema escuro, `ink` sobre `surface` alcança 15,1:1 e `ink-muted`, 7,2:1. As cores de
  texto de estado usam as variantes claras (`critical-strong` em `#FF9AA2`), com pelo
  menos 4,5:1 sobre os fundos `-soft` do tema.
- A navegação recolhida mantém o rótulo no DOM, em `sr-only`, e o repete como dica visual
  ao passar o ponteiro.
- O `Select` implementa o teclado do seletor nativo e anuncia a opção ativa por
  `aria-activedescendant`.
- No mapa de concentração, cada estado é alcançável por teclado e anuncia nome, valor e
  intensidade; o resumo por região aparece em texto abaixo, para que a cor nunca seja a
  única leitura.

### Limitações conhecidas

Dois pontos herdados da identidade visual não alcançam o nível AA e ficam registrados
aqui para decisão consciente de quem usar o design system:

| Situação | Contraste | Como conviver |
| --- | --- | --- |
| Texto branco sobre `gradient-brand` | 2,9:1 a 3,7:1 | Restrito a rótulo de botão em negrito. A ação nunca é a única forma de entender a tela, e o mesmo comando aparece em texto no restante da interface. Uma variante mais escura do gradiente resolveria o ponto, ao custo de fidelidade à marca. |
| `ink-subtle` sobre `surface` | 2,6:1 | Uso limitado a placeholder e a texto decorativo. Informação que precisa ser lida usa `ink-muted` ou mais escuro. |

## 10. Como estender

1. Precisa de uma cor, tamanho ou raio novo? Acrescente o token em `app/globals.css`,
   com nome semântico, e use o token na tela.
2. Precisa de uma variante de componente? Acrescente a variante no arquivo do componente
   em `components/ui`, e não uma classe solta na tela.
3. Precisa de um dado novo na tela? Acrescente o recurso no `*-resource.ts` da tela, com
   o endpoint, o `map` e o conjunto de exemplo, e consuma pelo `useResource`. Tela não
   importa dado de exemplo direto.
4. Precisa de movimento novo? Use um token `animate-*` existente. Se nenhum servir,
   acrescente o token em `@theme` com duração e curva, e não uma animação solta na tela.
5. Toda adição entra também em `/design-system`, para que o guia continue refletindo o
   que existe de fato no código.

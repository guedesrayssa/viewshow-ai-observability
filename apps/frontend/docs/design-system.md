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
  - [2.5 Raios, sombras e gradientes](#25-raios-sombras-e-gradientes)
- [3. Componentes](#3-componentes)
- [4. Acessibilidade](#4-acessibilidade)
- [5. Como estender](#5-como-estender)

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
   O nome descreve o papel (`surface`, `ink-muted`, `line`), não a cor, de modo que
   uma futura versão escura da interface troque apenas os valores no arquivo de tokens.
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
| `text-display` | 40 / 48 | 700 | Título de abertura |
| `text-h1` | 32 / 40 | 700 | Título de tela |
| `text-h2` | 24 / 32 | 600 | Título de seção |
| `text-h3` | 20 / 28 | 600 | Título de bloco e valor de KPI |
| `text-title` | 16 / 24 | 600 | Título de cartão |
| `text-body` | 15 / 24 | 400 | Texto padrão e conteúdo de campo |
| `text-body-sm` | 14 / 22 | 400 | Texto de apoio e rótulo de botão |
| `text-label` | 13 / 20 | 500 | Rótulo de campo |
| `text-caption` | 12 / 18 | 400 | Legenda, selo, comparação com a base |
| `text-micro` | 11 / 16 | 400 | Nota de rodapé e aviso legal |

### 2.5 Raios, sombras e gradientes

| Token | Valor | Uso |
| --- | --- | --- |
| `rounded-field` | 12 px | Campos, botões e avisos |
| `rounded-card` | 16 px | Cartões e painéis, conforme o Figma |
| `rounded-panel` | 24 px | Contêineres maiores |
| `rounded-pill` | circular | Selos, pontos de estado e avatares |
| `shadow-card` | discreta | Separa o cartão do fundo sem borda pesada |
| `shadow-raised` | média | Menus, popovers e elementos flutuantes |
| `shadow-brand` | quente | Exclusiva do botão em gradiente |
| `bg-gradient-brand` | laranja para vermelho | Ação primária e destaques |
| `bg-gradient-navy` | navy | Painéis institucionais escuros |
| `bg-gradient-orb` | laranja para roxo | Esferas decorativas do login |

## 3. Componentes

Todos ficam em `components/ui` e são documentados com exemplo no próprio arquivo.

| Componente | Arquivo | Variantes |
| --- | --- | --- |
| `Button` | `button.tsx` | `gradient`, `solid`, `outline`, `ghost`, `quiet`; tamanhos `sm`, `md`, `lg`; estados `loading` e `disabled` |
| `TextField`, `PasswordField` | `input.tsx` | Alturas `sm`, `md`, `lg`; rótulo, apoio e erro já conectados |
| `Input`, `Label`, `FieldHint`, `FieldError` | `input.tsx` | Primitivos, para composições fora do padrão |
| `Select` | `select.tsx` | Alturas `sm`, `md`, `lg`; ícone à esquerda opcional. Para barras de filtro, onde o valor escolhido já é o rótulo visível do campo |
| `Card`, `CardTitle`, `CardDescription` | `card.tsx` | Faixa de destaque `critical`, `warning`, `info`, `brand`, à esquerda ou no topo |
| `Badge` | `badge.tsx` | `critical`, `warning`, `success`, `info`, `neutral`, `brand`, com ou sem ponto |
| `Alert` | `alert.tsx` | `critical`, `warning`, `success`, `info` |
| `Logo`, `LogoMark` | `logo.tsx` | Aplicações `brand`, `gradient` e `mono` do manual |
| Ícones | `icons.tsx` | Conjunto mínimo em SVG inline, sem dependência externa |

Regras de composição:

- **Uma ação primária por área de decisão.** O gradiente marca a ação principal; o azul
  sólido, ações de navegação e confirmação; contorno e texto, alternativas.
- **Rótulo sempre visível acima do campo.** Placeholder é exemplo de preenchimento, não
  substitui rótulo.
- **Erro abaixo do campo, em texto.** A borda vermelha reforça, mas não é o único sinal.

## 4. Acessibilidade

- Contraste: `ink` sobre `surface` alcança 17,4:1 e `ink-muted` sobre `surface`, 5,0:1,
  ambos acima do mínimo AA para texto (4,5:1). Sobre `canvas`, `ink-muted` fica em 4,6:1.
- Foco: anel de 2 px em `brand-blue-light` com deslocamento de 2 px em todo elemento
  interativo, atendendo ao critério 2.4.11 das WCAG 2.2.
- Formulários: rótulo associado por `htmlFor`, `aria-invalid` no campo com erro e
  `aria-describedby` apontando para a mensagem em vigor.
- Erros de envio aparecem em um `Alert` com `role="alert"`, anunciado assim que surge, e
  o foco vai para o primeiro campo inválido.
- Ilustrações decorativas, como o painel do login, ficam com `aria-hidden`.
- A animação de carregamento respeita `prefers-reduced-motion`.

### Limitações conhecidas

Dois pontos herdados da identidade visual não alcançam o nível AA e ficam registrados
aqui para decisão consciente de quem usar o design system:

| Situação | Contraste | Como conviver |
| --- | --- | --- |
| Texto branco sobre `gradient-brand` | 2,9:1 a 3,7:1 | Restrito a rótulo de botão em negrito. A ação nunca é a única forma de entender a tela, e o mesmo comando aparece em texto no restante da interface. Uma variante mais escura do gradiente resolveria o ponto, ao custo de fidelidade à marca. |
| `ink-subtle` sobre `surface` | 2,6:1 | Uso limitado a placeholder e a texto decorativo. Informação que precisa ser lida usa `ink-muted` ou mais escuro. |

## 5. Como estender

1. Precisa de uma cor, tamanho ou raio novo? Acrescente o token em `app/globals.css`,
   com nome semântico, e use o token na tela.
2. Precisa de uma variante de componente? Acrescente a variante no arquivo do componente
   em `components/ui`, e não uma classe solta na tela.
3. Toda adição entra também em `/design-system`, para que o guia continue refletindo o
   que existe de fato no código.

# Frontend do View Show

Aplicação web do View Show, construída com **Next.js 16 (App Router)**, **React 19**,
**TypeScript** e **Tailwind CSS v4**. Esta pasta concentra o design system do produto
e as telas do painel.

## Como rodar

```bash
npm install
npm run dev      # ambiente de desenvolvimento em http://localhost:3000
npm run build    # build de produção
npm run lint     # ESLint
```

Rotas disponíveis hoje:

| Rota | Conteúdo |
| --- | --- |
| `/` | Redireciona para `/login` |
| `/login` | Tela de acesso por conta corporativa |
| `/recuperar-senha` | Orientação de recuperação de acesso |
| `/incidentes` | Incidentes e degradações que exigem atenção, com busca, filtros e ordenação |
| `/evidencias` | Hipótese de causa provável e evidências que sustentam o diagnóstico de um incidente |
| `/eventos` | Eventos e sessões correlacionados, com o dado normalizado ligado à fonte original |
| `/monitoramento` | Saúde do pipeline de telemetria, qualidade das fontes e concentração geográfica |
| `/design-system` | Guia vivo dos tokens e componentes |

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Endereço da API que intermedia a autenticação e as consultas. Sem ela, o login informa que a integração não está disponível em vez de falhar em silêncio. |

## Estrutura

```text
apps/frontend/
├── app/
│   ├── globals.css          # tokens do design system (fonte única de verdade)
│   ├── layout.tsx           # idioma, tipografia da marca e metadados
│   ├── page.tsx             # raiz, redireciona para o login
│   ├── (auth)/              # telas de acesso, com o painel ilustrado
│   │   ├── layout.tsx
│   │   ├── login/
│   │   └── recuperar-senha/
│   ├── (painel)/            # telas autenticadas, com a navegação lateral
│   │   ├── layout.tsx
│   │   ├── incidentes/
│   │   ├── evidencias/
│   │   ├── eventos/
│   │   └── monitoramento/
│   └── design-system/       # guia vivo dos componentes
├── components/ui/           # biblioteca de componentes
└── lib/                     # regras de acesso e utilitários
```

## Documentação

O ponto de entrada é [`documentacao-frontend.md`](./documentacao-frontend.md):
visão geral, arquitetura, estrutura de pastas e telas. Os domínios mais
autocontidos ficam em `docs/` — [camada de dados](./docs/camada-de-dados.md),
[componentes e gráficos](./docs/componentes.md), [tema](./docs/tema.md),
[autenticação](./docs/autenticacao.md) e o [design system](./docs/design-system.md).

## Design system

O guia completo está em [`docs/design-system.md`](./docs/design-system.md) e a versão
navegável, renderizada com o mesmo código das telas, em `/design-system`.

Três regras valem para qualquer tela nova:

1. **Nada de cor literal fora de `app/globals.css`.** Use os tokens semânticos
   (`bg-surface`, `text-ink-muted`, `border-line`, `rounded-card`).
2. **Nada de elemento nativo estilizado à mão.** Botões, campos, cartões, selos e
   avisos vêm de `components/ui`. Se falta uma variante, ela é acrescentada ao
   componente, não improvisada na tela.
3. **Cor nunca comunica sozinha.** Todo estado tem rótulo textual, conforme as
   WCAG 2.2 adotadas no projeto.

## Referências do projeto

- [Entendimento da experiência do usuário](../../artefatos/entendimento_ux.md), com personas, fluxos e a prancha de fundamentos visuais
- [Especificação de requisitos](../../artefatos/requisitos.md), com RF04, RNF04, RIE01 e RESTR01, que definem as regras de acesso
- [Protótipo no Figma](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437)

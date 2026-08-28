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
| `/login` | Tela de acesso por e-mail e senha ou SSO Globo |
| `/recuperar-senha` | Orientação de recuperação de acesso |
| `/visao-geral` | Hub do painel: estado do ecossistema em tempo quase real |
| `/configuracoes` | Conta, notificações e acesso corporativo |
| `/incidentes` | Incidentes e degradações que exigem atenção, com busca, filtros e ordenação |
| `/evidencias` | Hipótese de causa provável e evidências que sustentam o diagnóstico de um incidente |
| `/eventos` | Eventos e sessões correlacionados, com o dado normalizado ligado à fonte original |
| `/monitoramento` | Saúde do pipeline de telemetria, qualidade das fontes e concentração geográfica |
| `/design-system` | Guia vivo dos tokens e componentes |

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Endereço da API de telemetria e autenticação. Sem ela, as telas leem o conjunto de exemplo e dizem isso em texto, e a entrada abre uma sessão de demonstração. |

Os caminhos consumidos ficam em [`lib/data/endpoints.ts`](./lib/data/endpoints.ts) e
espelham as rotas do backend em `apps/basica/backend`. Cada tela declara, no seu
`*-resource.ts`, o endpoint que vai servi-la, como converter a resposta e o que mostrar
enquanto a API não responde — ligar o backend não muda nenhum componente.

## Estrutura

```text
apps/frontend/
├── app/
│   ├── globals.css          # tokens do design system (fonte única de verdade)
│   ├── layout.tsx           # idioma, tipografia, tema e perfil da conta
│   ├── page.tsx             # raiz, redireciona para o login
│   ├── (auth)/              # telas de acesso, com o painel ilustrado
│   │   ├── layout.tsx
│   │   ├── login/
│   │   └── recuperar-senha/
│   ├── (painel)/            # telas autenticadas, com a navegação lateral
│   │   ├── layout.tsx
│   │   ├── visao-geral/     # cada tela traz `*-view`, `*-data` e `*-resource`
│   │   ├── incidentes/
│   │   ├── evidencias/
│   │   ├── eventos/
│   │   ├── monitoramento/
│   │   └── configuracoes/
│   └── design-system/       # guia vivo dos componentes
├── components/
│   ├── account/             # perfil em sessão: nome e foto
│   ├── dashboard/           # cabeçalho, filtros, cartões e gráficos do painel
│   ├── motion/              # entrada de conteúdo e números animados
│   ├── settings/            # cartões da tela de Configurações
│   ├── shell/               # navegação lateral, barra superior e moldura
│   ├── theme/               # tema claro e escuro
│   └── ui/                  # biblioteca de componentes
├── hooks/                   # leitura de recursos, media queries e movimento
└── lib/
    ├── data/                # ponte com a API de telemetria
    └── ...                  # acesso, tema, formatação e utilitários
```

## Documentação

A documentação completa do frontend — arquitetura, estrutura de pastas, camada de
dados, telas, componentes, gráficos, tema e autenticação — está em
[`documentacao-frontend.md`](./documentacao-frontend.md).

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
4. **Tela não importa medição de módulo de exemplo.** Todo número passa pela camada de
   dados e chega pelo `useResource`, com os quatro estados desenhados: esperando, com
   dado, atualizando e sem leitura.

## Referências do projeto

- [Entendimento da experiência do usuário](../../artefatos/entendimento_ux.md), com personas, fluxos e a prancha de fundamentos visuais
- [Especificação de requisitos](../../artefatos/requisitos.md), com RF04, RNF04, RIE01 e RESTR01, que definem as regras de acesso
- [Protótipo no Figma](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437)

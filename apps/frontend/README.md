# Frontend do View Show

Painel estático em Next.js 16, React 19, TypeScript e Tailwind CSS v4. Layout,
componentes, textos, tokens, assets e responsividade são preservados; a camada
de resources adapta o contrato público do gateway aos tipos das telas.

## Execução

```bash
npm ci
npm run dev -- -p 3004
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Copie `.env.example` para `.env.local` e configure uma única API:

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Base pública do gateway; `/` significa mesma origem no Amplify. |
| `NEXT_PUBLIC_ALLOW_EXAMPLE_DATA` | Fixtures somente por opt-in em desenvolvimento/teste; ignorada em produção. |

Sem gateway ou dado real, a interface usa seus estados existentes de parcial
ou indisponível. A autenticação nunca declara sessão de demonstração sem a flag
explícita e não guarda token em `localStorage`.

## Camada de integração

- `lib/data/client.ts`: envelope `{data,meta}`, erros com requestId, timeout,
  warnings, freshness, partialidade e refresh hint.
- `lib/data/endpoints.ts`: somente `/api/v1/*` e `/auth/*` públicos.
- `app/(painel)/*/*-resource.ts`: adaptadores DTO → tipos visuais.
- `hooks/use-resource.ts`: loading, ready, refresh e indisponibilidade.

Eventos exigem `?incidente=<id>` explícito. Revisão humana envia o ID de
hipótese e `expectedVersion` e mostra conflito 409.

## Rotas

`/login`, `/criar-conta`, `/recuperar-senha`, `/visao-geral`, `/incidentes`,
`/evidencias`, `/eventos`, `/monitoramento`, `/configuracoes` e
`/design-system`.

Leia [camada de dados](docs/camada-de-dados.md),
[deploy integrado](docs/deploy-aws-integrado.md) e
[design system](docs/design-system.md).

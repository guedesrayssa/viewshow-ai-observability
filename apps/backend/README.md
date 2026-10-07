# Backend operacional

O backend operacional é uma única aplicação Node.js 22 com Express 5 e código
fonte integralmente em TypeScript. Ela roda como um processo no ECS/Fargate e
expõe `/health`, `/metrics`, a superfície federada `/auth/session`,
`/auth/login`, `/auth/callback` e `/auth/logout`, além de `/api/v1/*`.

## Organização

O código executável fica em `api/src` e segue um monólito modular:

```text
api/src/
├── app.ts                    composição HTTP e middleware
├── index.ts                  bootstrap e encerramento do processo
├── modules/
│   ├── auth/                 sessão e provedor de identidade
│   ├── dashboard/            overview e monitoramento
│   ├── imports/              limite fail-closed da importação
│   └── incidents/            incidentes, diagnóstico, eventos e revisão
└── observability/            métricas e telemetria
```

Cada módulo separa aplicação, domínio, portas e adaptadores. A comunicação entre
módulos acontece em processo; não existem APIs HTTP internas, supervisor ou
microsserviços aninhados. `api/contracts` concentra schemas, DTOs e o contrato
OpenAPI público, sem regra de domínio.

`ingestion-data/` e `agentic/` são processos separados da API operacional. A
ingestão materializa as projeções versionadas consumidas pelo gateway; o worker
agêntico consome SQS e persiste diagnósticos, hipóteses e fatos A′ que a API
expõe ao frontend. Eles não entram no build do processo Express, mas compartilham
os contratos do DynamoDB e a correlação observável da plataforma.

## Comandos

Execute em `apps/backend/api`:

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:ci-policy
npm run build
npm run test:e2e-local
npm start
```

O `pretest` compila `api/contracts`, portanto uma instalação limpa consegue
resolver `@view-show/contracts` sem depender de artefatos deixados por outro
comando. `test:e2e-local` inicia o DynamoDB Local em Docker, injeta somente
credenciais dummy e executa o contrato HTTP vivo; não acessa uma conta AWS.
Para executar diretamente `npm run test:e2e`, informe
`DYNAMODB_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` e
`AWS_SECRET_ACCESS_KEY` com valores locais.

## Configuração e persistência

`AUTH_COOKIE_SECRET` e `CURSOR_SECRET` exigem pelo menos 32 caracteres.
`DYNAMODB_ENDPOINT` é opcional e existe para apontar os adaptadores ao DynamoDB
Local em testes; quando ausente, o SDK usa o endpoint regional normal.

O contrato de identidade é exclusivamente federado: `GET /auth/login` inicia
a autorização, `GET /auth/callback` aceita `code` e `state`,
`GET /auth/session` lê a sessão assinada e `POST /auth/logout` remove o cookie.
O Cognito/OIDC está definido, mas o adaptador corporativo ainda não está
disponível; login e callback retornam `503 FEATURE_UNAVAILABLE`, sem fallback de
senha ou identidade inventada. Sessão ausente ou inválida retorna
`401 UNAUTHENTICATED`.

Os adaptadores consultam a tabela operacional com `Query`; `Scan` é proibido no
caminho da API. Chaves físicas e `LastEvaluatedKey` não atravessam o contrato
público. Projeções ausentes resultam em indisponibilidade ou parcialidade
explícita, sem inventar dados.

As três rotas de importação validam entrada e autenticação, porém o adaptador
S3/ingestão está definido como indisponível e responde
`503 FEATURE_UNAVAILABLE`. A solicitação de reanálise também valida sessão,
incidente e `Idempotency-Key`, mas a publicação SQS permanece definida e
indisponível, com a mesma falha fechada. A paridade entre manifesto, OpenAPI e
rotas Express e esses limites são cobertos pelos testes de contrato e pelo E2E
local vivo.

## Deploy

A imagem multi-stage compila TypeScript para `dist`, remove dependências de
desenvolvimento e inicia `node dist/index.js` sob `dumb-init`. A infraestrutura
existente preserva um container e uma porta (`3000`). As credenciais temporárias
do Learner Lab são responsabilidade do ambiente do pipeline e não ficam no
código.

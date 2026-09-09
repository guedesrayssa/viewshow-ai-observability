# Backend operacional

O backend operacional é uma única aplicação Node.js 22 com Express 5 e código
fonte integralmente em TypeScript. Ela roda como um processo no ECS/Fargate e
expõe `/health`, `/metrics`, `/auth/*` e `/api/v1/*`.

## Organização

O código executável fica em `api/src` e segue um monólito modular:

```text
api/src/
├── app.ts                    composição HTTP e middleware
├── index.ts                  bootstrap e encerramento do processo
├── modules/
│   ├── auth/                 sessão e provedor de identidade
│   ├── dashboard/            overview e monitoramento
│   └── incidents/            incidentes, diagnóstico, eventos e revisão
└── observability/            métricas e telemetria
```

Cada módulo separa aplicação, domínio, portas e adaptadores. A comunicação entre
módulos acontece em processo; não existem APIs HTTP internas, supervisor ou
microsserviços aninhados. `api/contracts` concentra schemas, DTOs e o contrato
OpenAPI público, sem regra de domínio.

`ingestion-data/` e `agentic/` são limites reservados para componentes futuros
descritos em `artefatos/arquitetura`; não fazem parte do build ou do runtime.

## Comandos

Execute em `apps/backend/api`:

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:ci-policy
npm run build
npm start
```

O `pretest` compila `api/contracts`, portanto uma instalação limpa consegue
resolver `@view-show/contracts` sem depender de artefatos deixados por outro
comando.

## Configuração e persistência

`AUTH_COOKIE_SECRET` e `CURSOR_SECRET` exigem pelo menos 32 caracteres. O login
de desenvolvimento só é habilitado com `IDENTITY_DEV_AUTH_ENABLED=true` e é
recusado em produção. Sem provedor corporativo, autenticação e SSO falham
fechado.

Os adaptadores consultam a tabela operacional com `Query`; `Scan` é proibido no
caminho da API. Chaves físicas e `LastEvaluatedKey` não atravessam o contrato
público. Projeções ausentes resultam em indisponibilidade ou parcialidade
explícita, sem inventar dados.

## Deploy

A imagem multi-stage compila TypeScript para `dist`, remove dependências de
desenvolvimento e inicia `node dist/index.js` sob `dumb-init`. A infraestrutura
existente preserva um container e uma porta (`3000`). As credenciais temporárias
do Learner Lab são responsabilidade do ambiente do pipeline e não ficam no
código.

# View Show

Plataforma de telemetria operacional do Globoplay, desenvolvida pelo Grupo 05
do Módulo 7 de Engenharia de Software do Inteli.

O estado vigente combina um painel Next.js estático com quatro microsserviços
TypeScript/Express executados em processos independentes. A infraestrutura AWS
existente foi preservada: o container atual no ECS inicia os quatro processos,
mas somente o gateway escuta publicamente na porta 3000.

## Estado dos diretórios

| Caminho | Estado e responsabilidade |
| --- | --- |
| `apps/frontend` | Painel Next.js 16; fala somente com o gateway público. |
| `apps/backend/api` | Workspace implantável: gateway, contratos e três serviços internos. |
| `apps/backend/ingestion-data` | Fronteira reservada; ingestão não está implementada nesta entrega. |
| `apps/backend/agentic` | Fronteira reservada; integração agêntica nova não está implementada. |
| `apps/infra` | Terraform existente e inalterado. |
| `apps/basica` | MVP histórico descontinuado, preservado apenas como histórico; nenhum runtime vigente depende dele. |
| `artefatos` | Requisitos, contratos, arquitetura, ADRs e evidências históricas. |

## Arquitetura vigente

```text
Next.js estático
       |
       v
API Gateway/BFF :3000
  | HTTP       | HTTP          | HTTP
  v            v               v
Incident :3001 Dashboard :3002 Identity :3003
  | Query/Update     | Query          | provedor configurável
  v                  v
DynamoDB existente (famílias encapsuladas por serviço)

Ingestion Data ── não implementado; produzirá read models
Agentic layer  ── não implementado; consumida apenas por ports futuros
```

Não há import entre implementações de serviços. O pacote compartilhado contém
somente DTOs, schemas, envelopes, erros e utilitários de observabilidade.

## Execução local

Requer Node.js 22 LTS.

```bash
cd apps/backend/api
npm ci
npm run verify

# Quatro processos, uma entrada pública
AUTH_COOKIE_SECRET=uma-chave-com-pelo-menos-32-bytes npm run start:compat
```

Em outro terminal:

```bash
cd apps/frontend
npm ci
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000 npm run dev -- -p 3004
```

Fixtures não são ativadas por padrão. Para uma demonstração local deliberada,
defina `NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true`; a flag é ignorada em produção.

## Verificação

```bash
cd apps/backend/api
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build

cd ../../frontend
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Documentação corrente

- [Backend e comandos](apps/backend/README.md)
- [Contrato público](apps/backend/api/contracts/openapi/public.openapi.json)
- [Contratos internos](apps/backend/api/contracts/openapi/internal.openapi.json)
- [Matriz de ownership](artefatos/contratos/endpoint-service-matrix.md)
- [ADR do empacotamento multiprocesso](artefatos/arquitetura/adr-microservices-ecs-compat.md)
- [Migração do legado](artefatos/arquitetura/backend-migration-guide.md)
- [Contrato normativo do dashboard](artefatos/contratos/dashboard-api-contract.md)

Os documentos das Sprints 1–3 continuam históricos. Referências antigas ao
MVP Flask não definem a arquitetura atual.

## Integrantes

João Freitas, Raiane Araujo Brandão, Rayssa Guedes França, Messias Olivindo,
Victor Garcia dos Santos, Marcos Vinicius M. Silva, Lucas Michel Pereira e
Bruno Martins.

## Licença

Creative Commons Attribution 4.0 International (CC BY 4.0).

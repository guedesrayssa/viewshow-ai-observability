# Backend operacional

O backend é um conjunto de quatro aplicações Node independentes. Para manter o
contexto Docker que o Terraform atual fixa em `apps/backend/api`, os workspaces
executáveis vivem abaixo dessa pasta nesta fase. Essa localização não muda as
fronteiras: cada aplicação possui package, configuração, porta, bootstrap,
health check e processo próprios, e integra-se somente por HTTP.

## Serviços

| Workspace | Porta | Responsabilidade |
| --- | ---: | --- |
| `api/` | 3000 | Gateway/BFF público, segurança de borda, auth proxy, envelopes e RED metrics. |
| `api/incidents-service/` | 3001 | Incidentes, diagnóstico persistido, eventos disponíveis e revisão otimista. |
| `api/dashboard-query-service/` | 3002 | Read models `VIEW#...`, freshness, cobertura e capacidades. |
| `api/identity-service/` | 3003 | Sessão assinada e provedor de identidade configurável/fail-closed. |
| `api/runtime-compat/` | — | Supervisor dos quatro processos na task ECS atual. |
| `api/contracts/` | — | Schemas/DTOs/OpenAPI sem regra de domínio. |

`ingestion-data/` e `agentic/` são placeholders sem servidor, worker ou lógica.

## Fluxo e dependências

```text
route -> application use case -> domain policy -> port -> adapter
```

O gateway não acessa DynamoDB. Incident Service e Dashboard Query Service não
compartilham repositories. Identity não valida senha local em produção. A
camada agêntica congelada permanece fora do build TypeScript e do runtime.

## Comandos

Execute em `apps/backend/api`:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run start:incidents
npm run start:dashboard-query
npm run start:identity
npm start
npm run start:compat
```

Configuração obrigatória comum: `INTERNAL_AUTH_TOKEN` (24+ caracteres). Incident
Service também exige `CURSOR_SECRET` (32+); Identity exige
`AUTH_COOKIE_SECRET` (32+). O supervisor gera segredos efêmeros somente fora de
produção. Em produção, o cookie secret precisa vir do ambiente.

## Persistência

Nenhum recurso AWS novo é criado. Os adapters usam apenas `Query` e atualização
condicional na tabela operacional existente. Chaves físicas e
`LastEvaluatedKey` ficam dentro dos adapters; o cursor público é autenticado e
opaco. Projeção ausente retorna 503 ou resposta parcial explícita.

## Deploy compatível

A imagem multi-stage usa Node 22.22.0, compila para `dist`, remove dependências
de desenvolvimento e roda como `node` sob `dumb-init`. O supervisor inicia
quatro processos e encerra o container se um essencial morrer. A separação em
containers/ECS Services futuros não requer mudança de contrato.

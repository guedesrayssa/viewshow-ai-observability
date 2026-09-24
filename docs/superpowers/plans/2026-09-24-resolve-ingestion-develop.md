# Resolver a integração de ingestion com develop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar `origin/develop` à implementação ARGUS sem perder segurança de sessão, contratos públicos ou consumidores do painel.

**Architecture:** A resolução inicia no contrato OpenAPI, consolida o runtime TypeScript da API e só então adapta os recursos React que leem esses payloads. Os testes de contrato e das rotas funcionam como fronteira entre o worker de ingestion, a API e o frontend; Terraform não recebe alteração funcional.

**Tech Stack:** Git, TypeScript, Express, Zod, Vitest, Next.js, Python/Pytest e Terraform.

**Spec:** `docs/superpowers/specs/2026-09-24-resolve-ingestion-develop-design.md`

## Global Constraints

- Não expor tokens Cognito no corpo de `POST /auth/password-login`; a sessão permanece em cookie HttpOnly.
- Preservar as rotas e schemas ARGUS de importação, live sync, eventos e evidências.
- Não executar Terraform apply, deploy ou chamadas mutáveis à AWS.
- Não aceitar dados de demonstração como fallback silencioso para eventos ou evidências.

## Review Focus

- Login válido não deve retornar `token`, `tokenType` nem `expiresInSeconds`; o teste da rota deve exigir somente `user`.
- A OpenAPI deve conter as rotas ARGUS que o runtime expõe, incluindo `GET/PATCH /api/v1/integrations/argus`.
- Eventos sem incidente correlacionado devem continuar serializáveis e visíveis ao frontend.
- Evidências devem manter `correlation`, `quality` e metadados de origem, inclusive quando `observedAt` for nulo.
- Navegação do painel deve conter uma única entrada para cada tela de eventos e evidências.

---

### Task 1: Integrar o contrato público da API

**Files:**
- Modify: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modify: `apps/backend/api/tests/contracts.test.ts`
- Modify: `apps/backend/api/tests/gateway-http.integration.test.ts`

**Interfaces:**
- Consumes: as rotas declaradas em `apps/backend/api/src/http/public-routes.ts` e os schemas Zod usados por `src/app.ts`.
- Produces: um documento OpenAPI 3.1 que descreve a resposta de sessão endurecida e todas as rotas ARGUS consumidas nas Tasks 2 e 3.

- [ ] **Step 1: Iniciar o merge sem commit na worktree isolada**

Run: `git merge --no-commit --no-ff origin/develop`

Expected: o índice apresenta os 21 conflitos previamente identificados, sem alterar a branch de trabalho original.

- [ ] **Step 2: Escrever os testes de convergência do contrato**

Em `contracts.test.ts`, acrescente uma asserção que carregue `public.openapi.json` e exija simultaneamente a rota `/api/v1/integrations/argus` com métodos GET/PATCH e os campos `role`/ `issuedAt` no usuário. Em `gateway-http.integration.test.ts`, a resposta de login deve falhar se contiver `token`, `tokenType` ou `expiresInSeconds`.

- [ ] **Step 3: Executar os testes para observar a falha RED**

Run: `npm test -- --run tests/contracts.test.ts tests/gateway-http.integration.test.ts`

Expected: FAIL porque o contrato em conflito não contém a combinação completa de sessão segura e rota ARGUS.

- [ ] **Step 4: Resolver o conflito de OpenAPI sem substituir um lado pelo outro**

No documento final, mantenha a descrição de login que não devolve tokens, o schema de usuário com `role` e `issuedAt`, e acrescente integralmente as rotas/schemas ARGUS da branch de ingestion. Remova os marcadores de conflito apenas desses arquivos.

- [ ] **Step 5: Executar os testes para observar GREEN**

Run: `npm test -- --run tests/contracts.test.ts tests/gateway-http.integration.test.ts`

Expected: PASS, com as duas regras de convergência satisfeitas.

- [ ] **Step 6: Commitar o contrato resolvido**

Run: `git add apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/gateway-http.integration.test.ts && git commit -m "fix(api): converge auth and argus public contract"`

Expected: commit criado com o contrato e seus testes.

### Task 2: Integrar runtime, domínio e adaptador da API

**Files:**
- Modify: `apps/backend/api/src/app.ts`
- Modify: `apps/backend/api/src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.ts`
- Modify: `apps/backend/api/src/modules/incidents/application/incident-use-cases.ts`
- Modify: `apps/backend/api/src/modules/incidents/domain/incident.ts`
- Modify: `apps/backend/api/tests/dashboard-queries.test.ts`
- Modify: `apps/backend/api/tests/dynamodb-adapters.test.ts`
- Modify: `apps/backend/api/tests/incident-use-cases.test.ts`
- Modify: `apps/backend/api/tests/live-api.e2e.test.ts`

**Interfaces:**
- Consumes: o contrato final da Task 1 e os registros canônicos publicados pela ingestion.
- Produces: handlers de API que preservam sessão segura e retornam eventos/evidências com correlação, qualidade e origem.

- [ ] **Step 1: Escrever um teste de regressão da resposta canônica**

No teste de query de eventos, use um evento sem correlação e exija `correlation.status === "unlinked"`, `incidentIds === []`, `quality.flags` como array e `source.dataset` como string.

- [ ] **Step 2: Executar o teste RED**

Run: `npm test -- --run tests/dashboard-queries.test.ts`

Expected: FAIL enquanto os tipos e o repositório permanecem em conflito ou não preservam o evento sem incidente.

- [ ] **Step 3: Resolver os conflitos do runtime**

Em `app.ts`, conservar `loginRateLimiter`, `verifyWithIssuedAt` e o retorno sem tokens; além disso, conservar parser de 4 MiB para conclusão de importação, dependências `argus`/`imports` e handlers ARGUS. No domínio, caso de uso e adaptador DynamoDB, unir os campos de correlação/qualidade/origem da ingestion às validações e filtros de `develop`; não converter evento não correlacionado em incidente fictício.

- [ ] **Step 4: Resolver os testes e executar GREEN**

Run: `npm test -- --run tests/dashboard-queries.test.ts tests/dynamodb-adapters.test.ts tests/incident-use-cases.test.ts tests/live-api.e2e.test.ts`

Expected: PASS; a cobertura inclui o evento sem correlação e a sessão segura.

- [ ] **Step 5: Commitar o runtime resolvido**

Run: `git add apps/backend/api/src apps/backend/api/tests && git commit -m "fix(api): preserve secure auth with argus data flows"`

Expected: commit criado com runtime e testes.

### Task 3: Adaptar os consumidores do painel ao contrato convergido

**Files:**
- Modify: `apps/frontend/app/(auth)/login/login-form.tsx`
- Modify: `apps/frontend/app/(auth)/login/login-form.test.tsx`
- Modify: `apps/frontend/app/(painel)/eventos/events-resource.ts`
- Modify: `apps/frontend/app/(painel)/eventos/events-view.tsx`
- Modify: `apps/frontend/app/(painel)/evidencias/evidence-resource.ts`
- Modify: `apps/frontend/app/(painel)/evidencias/evidence-view.tsx`
- Modify: `apps/frontend/app/(painel)/layout.tsx`
- Modify: `apps/frontend/app/(painel)/sidebar-nav.tsx`
- Modify: `apps/frontend/app/(painel)/sidebar-nav.test.tsx`
- Modify: `apps/frontend/components/account/account-provider.tsx`
- Modify: `apps/frontend/tests/monitoring-evidence-resources.test.ts`

**Interfaces:**
- Consumes: a resposta de login e os payloads de eventos/evidências da Task 2.
- Produces: telas sem tokens Cognito no cliente, com eventos, evidências e navegação deduplicada.

- [ ] **Step 1: Escrever os testes de convergência do frontend**

No teste de recursos, inclua uma evidência com `observedAt: null`, `correlation` e `quality.flags`; exija que ela seja mapeada sem fallback de exemplo. No teste de navegação, exija uma ocorrência de cada rota `/eventos` e `/evidencias`.

- [ ] **Step 2: Executar RED**

Run: `npm test -- --run tests/monitoring-evidence-resources.test.ts app/(painel)/sidebar-nav.test.tsx`

Expected: FAIL enquanto os dois lados do merge descrevem estruturas diferentes ou duplicam navegação.

- [ ] **Step 3: Resolver os conflitos de recursos e telas**

Preserve o login baseado em cookie, sem leitura de token de resposta. Faça os recursos de eventos/evidências usarem a estrutura canônica final, preservando origem, qualidade e correlação. Una os itens add/add da navegação e os dois testes em vez de escolher uma versão inteira. Remova apenas marcadores de conflito e ramos de dados de demonstração não usados.

- [ ] **Step 4: Executar GREEN e checagem de tipos**

Run: `npm test -- --run tests/monitoring-evidence-resources.test.ts app/(painel)/sidebar-nav.test.tsx && npm run typecheck`

Expected: PASS, sem erro de tipo em payloads de eventos ou evidências.

- [ ] **Step 5: Commitar os consumidores resolvidos**

Run: `git add apps/frontend && git commit -m "fix(frontend): consume merged argus contracts"`

Expected: commit criado com os consumidores e testes.

### Task 4: Conciliar documentação e validar a integração

**Files:**
- Modify: `apps/fullstack/README.md`

**Interfaces:**
- Consumes: os comandos de setup e deploy existentes e os recursos definidos pelo Terraform.
- Produces: documentação que orienta setup do Learner Lab e criação de usuário Cognito sem executar AWS.

- [ ] **Step 1: Resolver o conflito de documentação**

Mantenha o fluxo `scripts/aws-learner-lab.mjs` da branch de ingestion e acrescente as instruções de criação de usuário Cognito de `develop` como alternativa pós-apply. Não altere `.tf` nem scripts operacionais nesta tarefa.

- [ ] **Step 2: Conferir que o merge está inteiramente resolvido**

Run: `git diff --check && git diff --name-only --diff-filter=U`

Expected: saída sem erros e sem arquivos não resolvidos.

- [ ] **Step 3: Executar as validações completas locais**

Run: `(cd apps/backend/api && npm run verify) && (cd apps/frontend && npm test && npm run typecheck && npm run build) && (cd apps/backend/ingestion-data && .venv/bin/python -m pytest -m "not mysql and not aws") && (cd apps/fullstack && terraform validate)`

Expected: todos os comandos terminam com código zero. Se o container MySQL não estiver ativo, registrar separadamente os testes `mysql` como não executados, sem alterar o código para escondê-los.

- [ ] **Step 4: Commitar a documentação e concluir o merge**

Run: `git add apps/fullstack/README.md && git commit -m "docs: reconcile learner lab and cognito setup" && git status --short`

Expected: árvore limpa e merge commit criado quando ainda estiver pendente.


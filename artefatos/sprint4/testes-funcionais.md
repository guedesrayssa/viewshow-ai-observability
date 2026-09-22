# Testes Funcionais

## Visão Geral

&emsp;Este documento define os testes funcionais do sistema ARGUS/View Show — alvo `apps/backend/api` (monólito modular TypeScript, Express 5, DynamoDB) — cobrindo os requisitos funcionais **RF01–RF10** definidos em [`sprint1/requisitos.md`](../sprint1/requisitos.md#2-requisitos-funcionais-rf). Para cada teste são especificados identificador, objetivo e requisito ou caso de uso relacionado, pré-condições e dados de entrada, procedimento de execução, resultado esperado, resultado obtido, situação (aprovado/reprovado) e evidências e instruções de reprodução.

&emsp;A suíte está organizada em quatro categorias:

- **Testes unitários** — validam uma função ou método isolado, com pelo menos um caso válido e um caso de erro.
- **Testes de integração** — validam a comunicação real entre duas camadas do sistema (ex.: HTTP e sessão, aplicação e banco de dados).
- **Testes de caso de uso e valor limite** — validam um fluxo de negócio completo e o comportamento nos extremos de uma entrada numérica.
- **Testes de carga funcional** — validam que a resposta permanece correta (não necessariamente rápida) conforme a concorrência aumenta.

&emsp;A base de todo teste abaixo é código ou requisito que **já existe** no repositório: nenhum RF, caso de uso, rota ou métrica foi inventado para esta entrega.

&emsp;A suíte atual (`npm test`, Vitest) tem 12 arquivos e roda **71 testes passando, 13 ignorados** (84 no total) sem nenhuma credencial AWS — os 12 ignorados são os casos da Seção 3 (`tests/incidents-aws-live.functional.test.ts`), que só rodam com `RUN_AWS_FUNCTIONAL=true` contra a stack real. As Seções 1 e 2 apontam, teste a teste, o que já está coberto por essa suíte — para reaproveitar como evidência — e o que precisa ser escrito.

## Priorização de execução

&emsp;A ordem de implementação e execução desta suíte segue o risco funcional de cada fluxo, não a ordem de apresentação das seções:

1. **Prioridade 1 — a consulta paginada como fluxo completo (Seção 3: fluxo principal CT-01, paginação subsequente A1/CT-02, pós-condições; e IT02).** O caso de uso de consulta filtrada e paginada de incidentes (RF09) é o de maior risco funcional do sistema: combina filtros cumulativos, cursor assinado (`CursorCodec`) e paginação sobre dado real em DynamoDB. Uma falha aqui — cursor aceito para filtro errado, página duplicada/pulada, ou paginação incorreta contra o banco real (hoje só coberta por adaptador mockado, ver IT02) — compromete diretamente a confiabilidade do dado usado na análise de falhas críticas (RF09) e no dashboard (RF07). Por isso, o fluxo completo de consulta paginada e a integração real com o DynamoDB Local (IT02) são implementados e executados primeiro.
2. **Prioridade 2 — valores de fronteira do `limit` (UT04 e os casos CT-05 a CT-09).** A validação isolada do `limit` no schema apoia a análise de valor limite exigida pelo barema e já está implementada e passando (UT04), mas cobre sozinha apenas a camada de schema: um `limit` inválido nunca chega ao banco, então o risco de dado incorreto exposto ao usuário é menor do que o risco coberto pela Prioridade 1. Por isso esses casos, embora necessários, vêm depois do fluxo completo na ordem de execução.
3. **Prioridade 3 — fluxos de exceção e de sessão (E1, E2, E4 / CT-10 a CT-12) e Testes de Carga (Seção 4).** Guardas de validação (janela temporal, cursor de outra combinação de filtros, sessão ausente) e os testes de carga dependem do fluxo principal e da massa de dados (N=150 incidentes) já estarem consolidados, e seu risco funcional é menor — rejeitar corretamente uma entrada inválida é menos crítico do que corromper ou misturar dados retornados como válidos.

## Sumário

- [Priorização de execução](#priorização-de-execução)

1. [Testes Unitários](#1-testes-unitários)
2. [Testes de Integração](#2-testes-de-integração)
3. [Testes de Caso de Uso e Análise de Valor Limite](#3-testes-de-caso-de-uso-e-análise-de-valor-limite)
4. [Testes de Carga Funcional](#4-testes-de-carga-funcional)
5. [Convenção de evidências](#5-convenção-de-evidências)

---

## 1. Testes Unitários

&emsp;Quatro testes unitários, cobrindo função/método isolado com pelo menos um caso válido e um caso de erro cada. Três das quatro já existiam na suíte Vitest; o quarto (UT04) expunha uma lacuna real (limite de paginação nunca testado nos seus extremos) e foi escrito nesta rodada, também alimentando a análise de valor limite da Seção 3. Os quatro testes foram executados e os quatro passaram.

### UT01 — `CursorCodec.encode` / `CursorCodec.decode`

| Campo | Descrição |
| --- | --- |
| Função testada | `CursorCodec` em [`src/modules/incidents/domain/cursor.ts`](../../apps/backend/api/src/modules/incidents/domain/cursor.ts) |
| Objetivo e requisito relacionado | Garantir que o cursor de paginação só é aceito para o mesmo conjunto de filtros com que foi emitido e que qualquer adulteração é rejeitada. RF09 (consultas filtradas) e RF07 (dashboard com filtros cumulativos) — o cursor é o mecanismo de paginação de `GET /api/v1/incidents` |
| Já existe? | **Sim** — `tests/domain.test.ts:70`, `"encrypts cursors and binds them to filters"` |
| Pré-condições e dados de entrada | Segredo de 32+ caracteres para a chave AES-256-GCM; um par `(offset, fingerprint)` de filtros válido |
| Procedimento | 1. Instanciar `CursorCodec` com um segredo fixo. 2. `encode(20, "filter-a")` e conferir que o cursor não contém o texto do filtro em claro. 3. `decode(cursor, "filter-a")` deve devolver `20` (caso válido). 4. `decode(cursor, "filter-b")` (fingerprint errado) deve lançar `ServiceError` (caso de erro). 5. Adulterar um caractere do cursor e chamar `decode` novamente — deve lançar `ServiceError` |
| Resultado esperado | Caso válido: offset original devolvido sem vazar o filtro no cursor. Caso de erro: `ServiceError` (400) para fingerprint incompatível e para cursor adulterado — nunca um offset silenciosamente incorreto |
| Resultado obtido | Offset original devolvido corretamente para o mesmo conjunto de filtros; `ServiceError` lançado tanto para fingerprint incompatível quanto para cursor adulterado, conforme esperado |
| Situação | Aprovado |
| Evidências / reprodução | `npm test -- domain.test.ts`, teste `"encrypts cursors and binds them to filters"`. Saída registrada em [`assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt) |

### UT02 — `CognitoPasswordAuthenticator.authenticate`

| Campo | Descrição |
| --- | --- |
| Função testada | `CognitoPasswordAuthenticator` em [`src/modules/auth/adapters/cognito-password-authenticator.ts`](../../apps/backend/api/src/modules/auth/adapters/cognito-password-authenticator.ts) |
| Objetivo e requisito relacionado | Garantir que uma credencial válida autentica o usuário com identidade e papel corretos, e que uma credencial rejeitada pelo Cognito é classificada como falha sem lançar exceção não tratada. RF04 (autenticação corporativa via provedor de identidade) |
| Já existe? | **Sim** — `tests/auth-password-login.test.ts:35` (login válido) e `tests/auth-password-login.test.ts:117` (mapeamento de erro) |
| Pré-condições e dados de entrada | Mock de `InitiateAuthFn` (substitui a chamada real ao Cognito); `clientId`/`clientSecret` de teste; um ID token JWT sintético com `email` e `cognito:groups` |
| Procedimento | 1. Caso válido: mock devolve `AuthenticationResult` com ID token contendo grupo `engineer`; chamar `authenticate({ username, password })` e conferir identidade, papel e tokens devolvidos. 2. Caso de erro: mock lança `NotAuthorizedException`; chamar `authenticate` e conferir que o retorno é `{ ok: false, reason: "invalid_credentials" }`, sem lançar exceção não tratada |
| Resultado esperado | Caso válido: `{ ok: true, identity: { role: "engineer", ... }, tokens: {...} }`. Caso de erro: falha classificada (`invalid_credentials`) e nunca uma sessão emitida a partir de credencial rejeitada pelo Cognito |
| Resultado obtido | Identidade, papel e tokens corretos devolvidos no login válido; cada exceção do Cognito (`NotAuthorizedException`, `UserNotFoundException`, `UserNotConfirmedException`, `PasswordResetRequiredException`, throttling, erro desconhecido, desafio sem `AuthenticationResult`, ID token ilegível) classificada como falha, sem exceção não tratada — 9 dos 9 testes do bloco passaram |
| Situação | Aprovado |
| Evidências / reprodução | `npm test -- auth-password-login.test.ts`, bloco `"CognitoPasswordAuthenticator"`. Saída registrada em [`assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt) |

### UT03 — `PasswordLoginUseCases.login` (tradução de falha em HTTP)

| Campo | Descrição |
| --- | --- |
| Função testada | `PasswordLoginUseCases` em [`src/modules/auth/application/password-login-use-cases.ts`](../../apps/backend/api/src/modules/auth/application/password-login-use-cases.ts) |
| Objetivo e requisito relacionado | Garantir que cada resultado do autenticador (sucesso ou uma das 6 razões de falha) é traduzido para o par `(status, code)` HTTP correto, sem que nenhuma falha de autenticação escape como erro genérico 500. RF04 — camada chamada pela rota `POST /auth/login` |
| Já existe? | **Sim** — `tests/auth-password-login.test.ts:179` (login válido) e `tests/auth-password-login.test.ts:211` (`it.each` com as 6 razões de falha) |
| Pré-condições e dados de entrada | Um `PasswordAuthenticatorPort` falso, parametrizado com cada `PasswordAuthOutcome` possível (`ok: true` e as 6 variantes de `ok: false`) |
| Procedimento | 1. Caso válido: port devolve `{ ok: true, identity, tokens }`; chamar `login(username, password)` e conferir que o resultado é `{ identity, tokens }`. 2. Caso de erro (repetir para as 6 razões): port devolve `{ ok: false, reason }`; chamar `login` e conferir que a promise rejeita com `{ status, code }` — por exemplo `invalid_credentials → 401/UNAUTHENTICATED`, `rate_limited → 429/RATE_LIMITED` |
| Resultado esperado | Login válido devolve identidade e tokens sem alteração. Cada razão de falha do Cognito mapeia para exatamente o par `(status, code)` documentado — nenhuma falha de autenticação deve escapar como 500 genérico |
| Resultado obtido | Login válido devolveu identidade e tokens sem alteração; as 6 razões de falha (`invalid_credentials → 401`, `user_not_confirmed → 403`, `password_reset_required → 403`, `challenge_required → 403`, `rate_limited → 429`, `unavailable → 503`) mapeadas para o par `(status, code)` correto — 7 dos 7 testes do bloco passaram |
| Situação | Aprovado |
| Evidências / reprodução | `npm test -- auth-password-login.test.ts`, bloco `"PasswordLoginUseCases"`. Mesma saída da UT02, registrada em [`assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt) |

### UT04 — `incidentsQuerySchema` (validação do parâmetro `limit`)

| Campo | Descrição |
| --- | --- |
| Função testada | `incidentsQuerySchema` em [`contracts/src/index.ts:275-304`](../../apps/backend/api/contracts/src/index.ts), campo `limit: z.coerce.number().int().min(1).max(100).default(20)` (linha 295) |
| Objetivo e requisito relacionado | Garantir que o parâmetro `limit` só aceita valores inteiros entre 1 e 100, rejeitando os demais antes de qualquer lógica de negócio. RF09 (consultas filtradas para análise de falhas críticas) — schema que valida a query de `GET /api/v1/incidents` |
| Já existe? | **Sim — escrito nesta rodada.** `tests/contracts.test.ts:220-223` já testava que `limit: "10"` era coagido para o número `10`, mas nenhum teste cobria os extremos do intervalo (`min(1)`, `max(100)`) nem o caso de erro (`limit` fora do intervalo ou não numérico); o teste `"enforces the limit boundaries (1-100, default 20) on incidentsQuerySchema"` foi adicionado para cobrir essa lacuna |
| Pré-condições e dados de entrada | Nenhuma — teste puro de schema Zod, sem HTTP nem banco. Entradas: `{}` (ausente), `{ limit: "1" }`, `{ limit: "100" }`, `{ limit: "0" }`, `{ limit: "101" }`, `{ limit: "abc" }` |
| Procedimento | 1. Caso válido (ausente): `incidentsQuerySchema.parse({})` → `limit` deve ser `20` (default). 2. Caso válido (limite inferior): `parse({ limit: "1" })` → `limit === 1`. 3. Caso válido (limite superior): `parse({ limit: "100" })` → `limit === 100`. 4. Caso de erro (abaixo do limite): `parse({ limit: "0" })` deve lançar. 5. Caso de erro (acima do limite): `parse({ limit: "101" })` deve lançar. 6. Caso de erro (não numérico): `parse({ limit: "abc" })` deve lançar |
| Resultado esperado | Os três valores dentro do intervalo `[1, 100]` (incluindo os dois extremos) são aceitos e coagidos para `number`; os três valores fora do intervalo ou de tipo inválido lançam `ZodError`, impedindo que a query chegue ao `IncidentUseCases` com um `limit` inválido |
| Resultado obtido | `{}` resultou em `limit === 20`; `{ limit: "1" }` em `limit === 1`; `{ limit: "100" }` em `limit === 100`; `{ limit: "0" }`, `{ limit: "101" }` e `{ limit: "abc" }` lançaram erro, conforme esperado |
| Situação | Aprovado |
| Evidências / reprodução | Teste adicionado em `tests/contracts.test.ts`. `npm test -- contracts.test.ts`, teste `"enforces the limit boundaries (1-100, default 20) on incidentsQuerySchema"`. Saída registrada em [`assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt) |

---

## 2. Testes de Integração

&emsp;Dois testes cruzando camadas diferentes: um já coberto pela suíte de integração HTTP existente, outro expondo uma lacuna real (persistência mockada, nunca exercitada contra um banco de verdade).

### IT01 — Camada HTTP (Express) × módulo de autenticação/sessão

| Campo | Descrição |
| --- | --- |
| Componentes verificados | `createApp` (Express, [`src/app.ts`](../../apps/backend/api/src/app.ts)) integrado de ponta a ponta com o módulo de auth real (`SessionCodec`, `IdentityUseCases`) — servidor HTTP real ouvindo em porta efêmera, requisição feita via `node:http` |
| Objetivo e requisito relacionado | Garantir que uma sessão emitida pela camada de domínio é aceita pela camada HTTP e que as rotas de login (federada e direta) respondem conforme o contrato documentado. RF04 (autenticação corporativa: sessão válida libera acesso, ausência/invalidez bloqueia) |
| Já existe? | **Sim** — `tests/gateway-http.integration.test.ts:145` (`"returns authenticated session details through the public success envelope"`) e `:175` (`"exposes the federated routes and direct password login"`) |
| Pré-condições e dados de entrada | App montado com `createApp`, `AUTH_COOKIE_SECRET` de teste (32+ chars), repositórios de incidentes/dashboard falsos (não é o alvo desta integração); cookie de sessão emitido pelo próprio `SessionCodec` do processo |
| Procedimento | 1. Subir o app em `127.0.0.1:0` (porta livre) com `createServer`. 2. Emitir uma sessão válida com `SessionCodec.issue(...)`. 3. Requisitar `GET /auth/session` com o cookie e conferir envelope de sucesso com a identidade. 4. Requisitar as rotas de login federado (`GET /auth/login`, `GET /auth/callback`) e `POST /auth/login` e conferir os contratos de resposta expostos pelo gateway HTTP |
| Resultado esperado | O cookie emitido pela camada de domínio é aceito pela camada HTTP e devolve a identidade correta no envelope público padronizado; as rotas de login (federada e direta) respondem com o contrato documentado, sem vazar campos internos |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Saída de `npm test -- gateway-http.integration.test.ts` registrada em `assets/testes-funcionais/<data>/resultado-vitest-gateway.txt` |

### IT02 — Aplicação (`IncidentUseCases`) × DynamoDB real (DynamoDB Local)

| Campo | Descrição |
| --- | --- |
| Componentes verificados | `IncidentUseCases` + `DynamoIncidentRepository` ([`src/modules/incidents/adapters/dynamodb-incident-repository.ts`](../../apps/backend/api/src/modules/incidents/adapters/dynamodb-incident-repository.ts)) contra uma instância **real** de DynamoDB Local — não o cliente AWS mockado |
| Objetivo e requisito relacionado | Garantir que incidentes gravados em um banco DynamoDB real são lidos e paginados corretamente pela aplicação, sem duplicatas nem campos físicos vazados. RF01/RF02 (evento persistido fica disponível para consulta) e RF09 (consulta filtrada e paginada sobre dado realmente gravado) |
| Já existe? | **Não — a escrever.** `tests/dynamodb-adapters.test.ts` cobre os mesmos adaptadores, mas com `client.send` **inteiramente mockado** (`vi.fn(async () => ({ Items: [] }))`), então nenhum teste hoje grava e lê de um banco de verdade — a integração real nunca foi exercitada |
| Pré-condições e dados de entrada | DynamoDB Local em `127.0.0.1:18000` (`-inMemory -sharedDb`); tabela criada com o esquema de `apps/fullstack/dynamodb.tf` (`pk`/`sk`, GSI `trace-index`); `DYNAMODB_ENDPOINT` apontando para o local; alguns incidentes sintéticos gravados via `PutItem`/`seed-carga.cjs` |
| Procedimento | 1. Subir DynamoDB Local e criar a tabela operacional com o schema do Terraform. 2. Gravar N incidentes sintéticos (N > `limit` de teste, ex.: 5 incidentes com `limit=2`). 3. Instanciar `DynamoIncidentRepository` apontando para o endpoint local e `IncidentUseCases` com um `CursorCodec` real. 4. Chamar `listIncidents({ limit: 2 })`, guardar `nextCursor`. 5. Chamar novamente com o `cursor` recebido e conferir que a segunda página não repete nenhum item da primeira e é consistente com o total gravado |
| Resultado esperado | Os itens persistidos no DynamoDB real são lidos, convertidos para DTO (sem campos físicos `pk`/`sk`) e paginados corretamente: união das páginas = total gravado, sem duplicatas, `hasMore` e `nextCursor` coerentes com o fim da lista |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Teste novo a adicionar em `tests/` (ex.: `tests/dynamodb-real.integration.test.ts`); log de execução e captura de `docker ps`/processo do DynamoDB Local em `assets/testes-funcionais/<data>/` |

---

## 3. Testes de Caso de Uso e Análise de Valor Limite

&emsp;Caso de uso escolhido: **consulta filtrada e paginada de incidentes** (RF09, rota `GET /api/v1/incidents`, exposta em [`src/http/public-routes.ts`](../../apps/backend/api/src/http/public-routes.ts) como `incidents`). É o único caso de uso do projeto com uma entrada numérica de faixa explícita e documentada em código: `limit` — inteiro entre **1 e 100**, padrão **20** (`incidentsQuerySchema`, `contracts/src/index.ts:295`) — combinada com um cursor opaco de paginação (`CursorCodec`, Seção 1/UT01) e com a regra de exclusividade entre `window` e o par `from`/`to` (`validateTemporalQuery`, `contracts/src/index.ts:251-262`).

### 3.1 Pré-condições e dados de entrada comuns

- Sessão autenticada válida — sem ela a rota responde `401` antes de qualquer validação de query; este caso de uso assume sessão válida e testa o que acontece **depois** da guarda de sessão. Na execução real (ver 3.6), a sessão vem de um login de senha real contra o Cognito (`POST /auth/login`), não de um cookie forjado com `SessionCodec`.
- Base de incidentes conhecida (300 incidentes sintéticos gravados via `scripts/seed-carga.cjs` com `ALLOW_REMOTE_SEED=1` direto na tabela DynamoDB real), para que `hasMore`/`nextCursor` tenham um valor determinístico em cada consulta.

### 3.2 Fluxo principal

&emsp;Cliente autenticado chama `GET /api/v1/incidents?window=1h&limit=20` (ou sem `limit`, usando o padrão); a API devolve até 20 incidentes da última hora, ordenados por `recent` (padrão), com `page.limit=20`, `page.hasMore` e `page.nextCursor` coerentes com o total disponível.

### 3.3 Fluxos alternativos

- **A1 — paginação subsequente:** repetir a chamada com o `nextCursor` da resposta anterior e os mesmos filtros; a segunda página não repete itens da primeira (mesmo mecanismo validado em `tests/incident-use-cases.test.ts:40`, `"paginates with a cursor bound to the original filters"`).
- **A2 — filtro de janela absoluta:** `from`+`to` sem `window` — válido segundo `validateTemporalQuery`.
- **A3 — combinação de facetas:** `deviceType`, `os`, `status` etc. combinados com `limit` no meio do intervalo (ex.: `limit=50`).

### 3.4 Fluxos de exceção

- **E1 — `window` e `from`/`to` juntos:** rejeitado por `validateTemporalQuery` (erro de validação, sem chegar ao banco).
- **E2 — cursor de outra combinação de filtros:** `CursorCodec.decode` rejeita por fingerprint incompatível (`ServiceError` 400 — mesma trilha da UT01).
- **E3 — `limit` fora do intervalo ou não numérico:** rejeitado por `incidentsQuerySchema` antes de qualquer chamada ao repositório (mesma trilha da UT04).
- **E4 — sessão ausente/inválida:** `401`, citado aqui apenas para registrar a ordem das guardas (sessão → schema → cursor → negócio).

### 3.5 Pós-condições

- A união de todas as páginas percorridas com o mesmo conjunto de filtros é igual ao total de incidentes que atendem ao filtro, sem duplicatas e sem lacunas.
- Nenhuma resposta traz mais itens do que o `limit` solicitado (ou o padrão, quando omitido).
- `page.hasMore=false` se e somente se não existir próxima página; `page.nextCursor=null` nesse caso.
- Nenhum campo físico de persistência (`pk`, `sk`, `ttl`) vaza no corpo da resposta (mesma regra validada em `tests/domain.test.ts:100-125` para o DTO de incidente).

### 3.6 Tabela de rastreabilidade — fluxos/condições × casos de teste

&emsp;Procedimento comum a todos os casos abaixo: autenticar uma sessão válida, enviar a requisição indicada na coluna "Entrada" para `GET /api/v1/incidents` e comparar o corpo e o status da resposta com o "Resultado esperado".

&emsp;**Execução real** (não simulada): os 12 casos rodam como requisições HTTP `fetch` reais em [`tests/incidents-aws-live.functional.test.ts`](../../apps/backend/api/tests/incidents-aws-live.functional.test.ts), contra a API implantada de verdade na AWS (ALB → ECS Fargate → DynamoDB, stack `apps/fullstack`, namespace `g05-s3`), autenticando com um login de senha real no Cognito (`POST /auth/login`) — não um `createApp()` local nem um cookie forjado. Como `GET /api/v1/incidents` só sustenta uma das três dimensões `deviceType`/`region`/`appVersion` por vez, CT-04 e CT-11 usam `deviceType=Mobile`/`deviceType=Web` (vocabulário real gerado por `seed-carga.cjs`), não `android`/`ios` como no rascunho original. Ver 3.7 para o passo a passo de reprodução.

| Fluxo/condição | Caso de teste | Entrada | Resultado esperado | Resultado obtido | Situação | Evidências / reprodução |
| --- | --- | --- | --- | --- | --- | --- |
| Fluxo principal | CT-01 | `GET /api/v1/incidents?window=1h` (sem `limit`) | `page.limit=20` (default); ≤ 20 itens; página coerente com o total | `page.limit=20`, itens ≤ 20, sem campo físico vazado | Aprovado | [`resultado-vitest-ct-01-a-12-aws.txt`](../../assets/testes-funcionais/2026-09-21/resultado-vitest-ct-01-a-12-aws.txt) |
| A1 — paginação subsequente | CT-02 | `window=6h&limit=5`, depois repetido com o `cursor` da resposta anterior | Segunda página sem itens repetidos da primeira; `hasMore` correto | `hasMore=true` na primeira página; nenhum id da segunda página presente na primeira | Aprovado | idem |
| A2 — janela absoluta | CT-03 | `from=<agora-2h>&to=<agora>` (sem `window`) | `200`, itens restritos à janela informada | `200`; todo `startedAt` dentro de `[from, to]` | Aprovado | idem |
| A3 — filtro por dimensão suportada | CT-04 | `deviceType=Mobile&window=24h&limit=50` | `200`, `page.limit=50`, itens só de `deviceType=Mobile` | `200`, `page.limit=50`; todo item com `scopeSummary.deviceType=Mobile` | Aprovado | idem |
| Limite — valor mínimo válido | CT-05 | `limit=1` | `200`, exatamente 1 item (se houver dado), `page.limit=1` | `200`, `page.limit=1`, ≤ 1 item | Aprovado | idem |
| Limite — abaixo do mínimo | CT-06 | `limit=0` | Erro de validação (400), nenhuma consulta ao banco | `400 VALIDATION_ERROR` | Aprovado | idem |
| Limite — valor máximo válido | CT-07 | `limit=100` | `200`, até 100 itens, `page.limit=100` | `200`, `page.limit=100`, ≤ 100 itens | Aprovado | idem |
| Limite — acima do máximo | CT-08 | `limit=101` | Erro de validação (400) | `400 VALIDATION_ERROR` | Aprovado | idem |
| Limite — tipo inválido | CT-09 | `limit=abc` | Erro de validação (400) | `400 VALIDATION_ERROR` | Aprovado | idem |
| E1 — `window` + `from`/`to` juntos | CT-10 | `window=1h&from=<agora-1h>&to=<agora>` | Erro de validação (400), mensagem "from e to devem ser enviados juntos..." | `400 VALIDATION_ERROR`; `error.fields[0].message` contém a mensagem esperada | Aprovado | idem |
| E2 — cursor de outro filtro | CT-11 | `cursor` obtido com `deviceType=Mobile`, reenviado com `deviceType=Web` | `400` (`VALIDATION_ERROR`, "O cursor é inválido para estes filtros.") | `400 VALIDATION_ERROR`, mensagem exata batida | Aprovado | idem |
| E4 — sem sessão | CT-12 | Mesma chamada de CT-01, sem cookie | `401`, corpo sem dado de incidente | `401 UNAUTHENTICATED` | Aprovado | idem |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026), com base em `contracts/src/index.ts` e `src/modules/incidents/`.</sup>

</div>

### 3.7 Reprodução contra a AWS real

&emsp;Nesta rodada (2026-09-21), a stack foi aplicada do zero na conta `080158589617` (`aws sts get-caller-identity`) do Learner Lab então ativo — 56 recursos criados, 0 alterados, 0 destruídos (`terraform apply`), com `GET /health` respondendo `200` logo em seguida. O estado local de uma sessão anterior, de outra conta (`985109744788`), foi preservado sem reaproveitamento em `apps/fullstack/.terraform-state-backup-985109744788/`, conforme a regra do README do projeto ("o estado legado pertence a outra conta e não pode ser adotado"). A massa de dados foi semeada com `scripts/seed-carga.cjs` (`ALLOW_REMOTE_SEED=1`) direto na tabela `g05-s3-operacional`: 300 incidentes / 2303 itens (incidentes + evidências + hipóteses), no mesmo formato de item já usado pelos testes de carga do sprint 3. A saída bruta do `vitest run` fica em [`assets/testes-funcionais/2026-09-21/resultado-vitest-ct-01-a-12-aws.txt`](../../assets/testes-funcionais/2026-09-21/resultado-vitest-ct-01-a-12-aws.txt); o passo a passo abaixo permite reproduzir do zero em qualquer sessão do Learner Lab.

```bash
# 1. Sessão válida do AWS Academy Learner Lab em ~/.aws/credentials
aws sts get-caller-identity --region us-east-1

# 2. Provisionar a stack (apps/fullstack) — fluxo controlado do README do projeto
cd apps/fullstack
terraform init -backend=false -input=false
terraform plan -input=false -out=.terraform-artifacts/g05-s3.tfplan
terraform show -json .terraform-artifacts/g05-s3.tfplan | \
  node ../../scripts/ci/validate-terraform-create-plan.mjs
terraform apply -input=false .terraform-artifacts/g05-s3.tfplan

# 3. Semear dados (nome da tabela sai do output tabelas_dynamodb)
cd ../backend/api
ALLOW_REMOTE_SEED=1 OPERATIONAL_TABLE_NAME=g05-s3-operacional \
  node scripts/seed-carga.cjs

# 4. Criar o usuário de teste no Cognito (user pool id sai do output cognito_user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id <cognito_user_pool_id> \
  --username "teste-funcional@viewshow.local" \
  --user-attributes Name=email,Value=teste-funcional@viewshow.local Name=email_verified,Value=true \
  --message-action SUPPRESS --region us-east-1
aws cognito-idp admin-set-user-password \
  --user-pool-id <cognito_user_pool_id> \
  --username "teste-funcional@viewshow.local" \
  --password "<senha-forte-com-maiuscula-minuscula-numero>" \
  --permanent --region us-east-1

# 5. Rodar os 12 casos contra a API real (api_url do output do terraform)
RUN_AWS_FUNCTIONAL=true \
AWS_API_BASE_URL=<api_url> \
AWS_TEST_USERNAME=teste-funcional@viewshow.local \
AWS_TEST_PASSWORD=<a mesma senha do passo 4> \
npx vitest run tests/incidents-aws-live.functional.test.ts --reporter=verbose
```

&emsp;Sem `RUN_AWS_FUNCTIONAL=true`, o arquivo de teste é pulado inteiro (inclusive o `beforeAll` que faz login) — `npm test` normal nunca tenta acessar a AWS.

---

## 4. Testes de Carga Funcional

&emsp;O objetivo de cada nível é duplo: (1) confirmar que a resposta continua **correta** (schema certo, dado certo, sem mistura entre requisições concorrentes) conforme a concorrência sobe; e (2) registrar, em cada um dos três níveis, os **tempos de resposta** (`http_req_duration`, p50/p95/p99) e a **taxa de erros** (`http_req_failed`), conforme pede o barema.

&emsp;**Reaproveitamento explícito de ferramenta.** Os três níveis reaproveitam a suíte k6 já existente em [`apps/backend/api/loadtest/k6/`](../../apps/backend/api/loadtest/k6/) — especialmente `consultas.js` (cenários A–G: lista de incidentes, diagnóstico, eventos, overview, monitoring e paginação) e `lib/session.js` (forja o cookie de sessão). A **carga gerada** (VUs, taxa de chegada, cenários sorteados) é a mesma ferramenta; a ela somam-se checks de conteúdo mais estritos do que os hoje existentes em `consultas.js` (que verificam presença de campos como "tem items"/"tem evidence", mas não o conteúdo) — schema da resposta, ausência de duplicidade entre páginas, ausência de campo físico vazado, correlação entre `X-Request-Id` enviado e devolvido; essa extensão do script (ou um script irmão, ex. `loadtest/k6/consultas-funcionais.js`) faz parte da implementação destes testes. Além dos checks de conteúdo, cada nível reporta as métricas nativas do k6 — tempo de resposta e taxa de erros — extraídas do resumo JSON de cada execução (`resumo-nivelN.json`), com `429`/`503` contabilizados à parte, como proteção esperada, e não como falha funcional.

### Nível 1 — Carga leve

| Campo | Descrição |
| --- | --- |
| Objetivo e requisito relacionado | Confirmar que, sob baixa concorrência, todas as respostas da API de consultas permanecem corretas (schema, dados, paginação) — execução real, via HTTP, das rotas ligadas a RF01/RF02/RF07/RF09 |
| Pré-condições e dados de entrada | Suíte k6 (`consultas.js` + `lib/session.js`) disponível; base de incidentes populada; endpoint da API acessível |
| Procedimento | Executar `consultas.js` em `MODE=smoke`, com 1–2 VUs em modelo de chegada aberto a ~1 req/s por ~30 s (ordem de grandeza: 34 requisições em 31 s), sorteando os cenários A–G; validar o corpo de cada resposta contra o contrato Zod correspondente |
| Critérios de sucesso | 100% das respostas `200` com corpo aderente ao contrato (funcional) **e** p95 de `http_req_duration` < 300 ms **e** taxa de erros (`http_req_failed`, respostas não-2xx) = 0% — nesta carga leve não há contenção esperada, logo nem `429` nem `503` deveriam ocorrer |
| Resultado esperado | 100% das respostas `200` trazem corpo aderente ao contrato Zod correspondente (`incidentsQuerySchema`/`IncidentsData` etc.), sem campo físico (`pk`, `sk`, `ttl`) vazado, `page.limit` bate com o `limit` pedido (ou o padrão), e as métricas de carga atendem aos critérios de sucesso acima |
| Tempos de resposta e taxa de erros (medidos) | `http_req_duration`: p50=182,4 ms · p95=422,0 ms · p99=617,5 ms · max=676,9 ms. `http_req_failed`=0% (0 de 35). `429`=0, `503`=0 |
| Resultado obtido | 35 requisições em ~31 s contra a API real na AWS (ALB `g05-s3-alb`); `checks`=100% (schema de `data.items`, ausência de `pk`/`sk`/`ttl`, eco de `X-Request-Id` e paginação sem duplicidade todos aprovados); nenhum `429`/`503` |
| Situação | Aprovado quanto à corretude funcional e à taxa de erros (0%); **reprovado quanto ao critério de latência** — p95 medido (422 ms) excede o limite de 300 ms do critério de sucesso |
| Análise e conclusão | O conteúdo das respostas está sempre correto sob carga leve — os quatro checks de conteúdo (schema, campo físico, duplicidade, `X-Request-Id`) passaram em 100% das chamadas. A latência, porém, não atende ao critério de 300 ms: mesmo sem contenção (~1 req/s), o p95 já é 422 ms, refletindo o RTT real até o ALB na AWS e uma task Fargate única de 1 vCPU — não um bug funcional. O critério de 300 ms do plano provavelmente assumia execução local; vale revisá-lo à luz do ambiente real de implantação. |
| Evidências / reprodução | `k6 run -e BASE_URL=<api_url> -e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha> -e MODE=smoke consultas.js`. Resumo completo em [`assets/testes-funcionais/2026-09-21/resumo-nivel1.json`](../../assets/testes-funcionais/2026-09-21/resumo-nivel1.json) |

### Nível 2 — Carga progressiva moderada

| Campo | Descrição |
| --- | --- |
| Objetivo e requisito relacionado | Confirmar que a paginação de incidentes (RF09) permanece correta — sem itens repetidos ou pulados — quando múltiplos usuários paginam concorrentemente sobre a mesma base, sob carga moderada e sustentada |
| Pré-condições e dados de entrada | Suíte k6 (`consultas.js`) configurada para taxa elevada de requisições por IP (janela controlada), de modo que a carga chegue à API em vez de ser barrada pelo limite de taxa (429); base de incidentes populada |
| Procedimento | Executar `consultas.js` em rampa até 137 req/s, sustentada por ~3–4 min (~30 mil requisições), com múltiplos VUs percorrendo o cenário G (paginação por cursor) concorrentemente |
| Critérios de sucesso | Cenário G sem itens repetidos/pulados entre páginas (funcional) **e** p95 de `http_req_duration` < 800 ms **e** taxa de erros "duros" (códigos diferentes de `200`/`429`/`503`) < 1% — sob 137 req/s sustentados alguma rejeição por limite de taxa é aceitável, desde que sinalizada como `429`, não como corpo incorreto |
| Resultado esperado | Cenário G percorrido de ponta a ponta sem repetir nem pular itens entre páginas, mesmo com múltiplos VUs paginando concorrentemente sobre a mesma base; nenhuma resposta `200` com corpo divergente do schema esperado; métricas de carga dentro dos critérios de sucesso acima |
| Tempos de resposta e taxa de erros (medidos) | Todas as respostas: `http_req_duration` p50=10.132 ms · p95=60.000 ms (teto do timeout) · p99=60.000 ms. Só `status:200`: p50=11.796 ms · p95=27.368 ms · p99=53.832 ms. `http_req_failed` (exclui `429`/`503`)=84,38%; `429`=0 (0%); vazão útil (`status:200`)=5,83 req/s, muito abaixo do alvo de 137 req/s; `dropped_iterations`=18.307 de ~28 mil ofertadas |
| Resultado obtido | `rate_limit_por_minuto` elevado para 20000 antes da rodada (nova revisão da task ECS, ver Seção 4.1) para isolar o rate limiter como variável. Com o limite fora do caminho, `429`=0 confirma que o gargalo passou a ser a capacidade computacional: a CPU da task ECS (`g05-s3-cluster/g05-s3-api-service`, CloudWatch) ficou entre 99% e 100% por ~4 min sustentados durante a rodada, e o autoscaling (min 1 / máx 4, alvo 50% CPU) **não escalou** dentro da janela do teste — `runningCount`/`desiredCount` permaneceram 1/1 o tempo todo. Apesar disso, os checks de conteúdo (schema de `data.items`, ausência de campo físico, cenário G sem duplicidade entre páginas) passaram em 100% das respostas que chegaram a se completar — nenhuma corrupção de dado, só indisponibilidade por saturação |
| Situação | **Aprovado quanto à corretude** (paginação sem itens repetidos/pulados, 100% dos checks de schema/conteúdo). **Reprovado quanto ao desempenho** — p95 medido (27,4 s em `status:200`; 60 s incluindo timeouts) muito acima do limite de 800 ms, e taxa de erros "duros" (84,38%) muito acima do limite de 1% |
| Análise e conclusão | A paginação nunca devolveu dado incorreto sob carga — o RF09 se sustenta funcionalmente mesmo saturado. Mas a configuração atual (1 task Fargate de 1 vCPU, autoscaling que não reage dentro de poucos minutos) não comprova RNF09/RNF14 na taxa alvo de 137 req/s: a vazão útil real ficou em ~5,8 req/s, e a maioria das requisições nem chegou a ser enviada (`dropped_iterations`) porque os VUs ficaram presos aguardando respostas lentas. Próximo passo natural, fora do escopo desta rodada: medir com `ecs_capacidade_minima>1` e/ou cooldown de scale-out menor. |
| Evidências / reprodução | `k6 run -e BASE_URL=<api_url> -e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha> -e MODE=load consultas.js`. Resumo completo em [`assets/testes-funcionais/2026-09-21/resumo-nivel2.json`](../../assets/testes-funcionais/2026-09-21/resumo-nivel2.json) |

### Nível 3 — Carga alta (equivalente a `breakpoint`/`estresse`)

| Campo | Descrição |
| --- | --- |
| Objetivo e requisito relacionado | Confirmar que, sob fila e latência altas (próximas ao ponto de saturação da API), toda resposta `200` continua com corpo correto — sem corrupção nem mistura de dados entre requisições concorrentes (RF01/RF02/RF09) |
| Pré-condições e dados de entrada | Perfis `breakpoint` (rampa 1→220 req/s) e/ou `estresse` (137→411 req/s) já definidos em `consultas.js`; base de incidentes populada |
| Procedimento | Executar `consultas.js` com o perfil `breakpoint` e/ou `estresse` (3–6 min, VUs máx. 30–1.500 conforme o perfil), verificando em cada resposta `200` a correlação entre o `X-Request-Id` enviado e devolvido e que nenhum incidente devolvido por `diagnosis`/`events` pertence a um `incidentId` diferente do solicitado |
| Critérios de sucesso | Nenhuma resposta `200` com corpo corrompido/trocado (funcional) **e** taxa de erros "duros" (códigos diferentes de `200`/`429`/`503`) = 0%, mesmo com p95/p99 de `http_req_duration` subindo à medida que a API se aproxima da saturação; `429`/`503` são esperados perto do breakpoint e não contam como falha |
| Resultado esperado | Toda resposta `200` mantém corpo correto e sem corrupção, mesmo sob saturação. Respostas `429`/`503` (comportamento de proteção conhecido) não contam como falha funcional; um `200` com corpo malformado ou trocado, sim; métricas de carga dentro dos critérios de sucesso acima |
| Tempos de resposta e taxa de erros (medidos) | Rodado só o perfil `breakpoint` (rampa 1→220 req/s, 6 min; `estresse` não rodado nesta entrega). `http_req_duration`: p50=8.489 ms · p95=57.152 ms · p99=60.000 ms (teto do timeout). `http_req_failed` (exclui `429`/`503`)=2,48% (121 de 4.874); `503` (`overview`/`monitoring`, projeção envelhecida)=136; `429`=0; `dropped_iterations`=19.077 |
| Resultado obtido | CPU da task ECS (CloudWatch, 1 min de granularidade) acompanhou a rampa: ~34% no estágio de 20 req/s, 46,5% em 40 req/s, saltando para 80,5% em 70 req/s e 97–100% a partir do estágio de 110 req/s — ponto aproximado de saturação entre **70 e 110 req/s** de carga nominal, bem abaixo do topo da rampa (220 req/s). Mesmo assim, todo `200` recebido veio com o schema correto, sem campo físico vazado e sem duplicidade entre páginas do cenário G — os três checks de conteúdo ficaram em 100% (0 falhas) nas 4.874 respostas completadas |
| Situação | **Aprovado quanto à corretude** — nenhuma resposta `200` veio corrompida ou trocada em nenhum ponto da rampa, incluindo além do ponto de saturação. **Reprovado quanto ao critério de erros "duros" = 0%** — 2,48% medido, concentrado nos estágios finais da rampa (timeouts, não `429`/`503`) |
| Análise e conclusão | O ponto de saturação (~70–110 req/s) é consistente com o achado do Nível 2 (vazão útil de ~5,8 req/s a 137 req/s de alvo): a mesma causa raiz — uma única task Fargate de 1 vCPU e autoscaling que não reage dentro de poucos minutos — explica os dois níveis. O resultado mais importante para RF01/RF02/RF09 é qualitativo: em nenhum momento da rampa, mesmo bem além do ponto de saturação, a API misturou ou corrompeu dado entre requisições concorrentes; ela degrada por indisponibilidade (timeout), não por incorreção. `estresse` (137→411 req/s sustentado) não foi executado nesta rodada — o `breakpoint` já expõe o mesmo teto de capacidade com uma rampa mais curta. |
| Evidências / reprodução | `k6 run -e BASE_URL=<api_url> -e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha> -e MODE=breakpoint consultas.js`. Resumo completo em [`assets/testes-funcionais/2026-09-21/resumo-nivel3.json`](../../assets/testes-funcionais/2026-09-21/resumo-nivel3.json) |

### 4.1 Rate limit elevado durante a janela de carga

&emsp;Os Níveis 2 e 3 precisam de mais de ~3 req/s por origem, acima do limite de produção (180 req/min por IP, `rateLimiter` em `src/app.ts`). Antes dessas duas rodadas, a variável Terraform `rate_limit_por_minuto` (`apps/fullstack/variables.tf:99`) foi elevada de 180 para 20000:

```bash
cd apps/fullstack
terraform plan -input=false -var='rate_limit_por_minuto=20000' -out=.terraform-artifacts/rate-limit-alto.tfplan
terraform apply -input=false .terraform-artifacts/rate-limit-alto.tfplan
```

&emsp;Isso gera uma nova revisão da task definition ECS (só o container muda) e atualiza o serviço — sem tocar em rede, banco ou dado; a mudança é 100% reversível. Depois de coletar os Níveis 2 e 3, o mesmo procedimento com `-var='rate_limit_por_minuto=180'` devolve o limite ao padrão de produção. Nenhuma resposta `429` apareceu nos Níveis 2 e 3 com o limite elevado, confirmando que o rate limiter deixou de ser a variável limitante — o gargalo observado (Seção 4, Níveis 2 e 3) é a capacidade computacional da task Fargate, não o rate limiter.

---

## 5. Convenção de evidências

&emsp;As evidências desta suíte devem ser versionadas em `assets/testes-funcionais/<data>/` — só os arquivos brutos (saída de ferramenta), sem `README.md` nem outra prosa explicativa na pasta: a descrição de cada arquivo e como reproduzi-lo vive neste documento (ver Seção 3.7 e as linhas "Evidências / reprodução" de cada tabela), não solta em `assets/`. A pasta reúne:

- saída de `npm test` (e, por teste, o arquivo específico) para as Seções 1 e 2;
- brutos JSON do k6 (`resumo-*.json`) e metadados de ambiente para a Seção 4;
- capturas de tela ou logs para os casos de uso da Seção 3, seguindo a convenção `teste-<seção>-<caso>-<descrição>.png` já usada em `assets/testes/` (ex.: `assets/testes/teste-1-1-ingestao-lote-eventos.png`).

&emsp;A Seção 1 (Testes Unitários) já foi executada: os quatro testes (UT01–UT04) passaram, com evidência em [`assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-unitarios.txt) e na saída completa da suíte em [`assets/testes-funcionais/2026-09-17/resultado-vitest-suite-completa.txt`](../../assets/testes-funcionais/2026-09-17/resultado-vitest-suite-completa.txt) (71 testes passando, 1 ignorado, de 11 arquivos).

&emsp;A Seção 3 (CT-01 a CT-12) também já foi executada — os 12 casos passaram contra a API implantada de verdade na AWS (não localmente), com evidência em [`assets/testes-funcionais/2026-09-21/resultado-vitest-ct-01-a-12-aws.txt`](../../assets/testes-funcionais/2026-09-21/resultado-vitest-ct-01-a-12-aws.txt) e passo a passo de reprodução na Seção 3.7.

&emsp;A Seção 4 (Níveis 1 a 3) também já foi executada contra a mesma stack AWS — resultados, análise e evidência (`resumo-nivel{1,2,3}.json`) em cada tabela da Seção 4. Resumo: correção de conteúdo (schema, ausência de campo físico, ausência de duplicidade entre páginas) aprovada nos três níveis, 100% das vezes que uma resposta chegou; desempenho aprovado só no Nível 1, e mesmo assim com ressalva no p95 — Níveis 2 e 3 expuseram que uma única task Fargate de 1 vCPU sem autoscaling reagindo a tempo não sustenta os alvos de RNF09/RNF14 nesta configuração. A linha restante deste documento (Seção 2) permanece com "Resultado obtido" e "Situação" como **a executar**.

### 5.1 Itens pendentes e plano de entrega

&emsp;Para que o andamento do planejamento possa ser acompanhado até a conclusão, cada item ainda em aberto tem local definido de implementação (quando é código a escrever) e de entrega da evidência de execução:

| Item pendente | Situação atual | Onde será implementado | Onde a evidência será entregue |
| --- | --- | --- | --- |
| IT02 (integração `IncidentUseCases` × DynamoDB Local) | **A escrever** — código não existe ainda, ver Seção 2 | Novo arquivo `tests/dynamodb-real.integration.test.ts` em `apps/backend/api/` | `assets/testes-funcionais/<data>/` (log de execução do teste e captura do processo/`docker ps` do DynamoDB Local) |
| IT01 (HTTP × sessão) | Código já existe (`tests/gateway-http.integration.test.ts`), execução pendente | N/A — já implementado | `assets/testes-funcionais/<data>/resultado-vitest-gateway.txt` |
| Seção 3 — casos CT-01 a CT-12 | **Concluído** — 12/12 aprovados, executados contra a API real na AWS (não local) | [`tests/incidents-aws-live.functional.test.ts`](../../apps/backend/api/tests/incidents-aws-live.functional.test.ts) em `apps/backend/api/` | `assets/testes-funcionais/2026-09-21/` (ver Seção 3.7) |
| Seção 4 — Níveis 1, 2 e 3 | **Concluído** — `consultas.js` estendido in-place com os checks de conteúdo mais estritos; 3 níveis executados contra a API real na AWS. Correção aprovada nos 3; desempenho aprovado só no Nível 1 (ver Seção 4) | [`apps/backend/api/loadtest/k6/consultas.js`](../../apps/backend/api/loadtest/k6/consultas.js) + [`lib/asserts.js`](../../apps/backend/api/loadtest/k6/lib/asserts.js) (novo) | `assets/testes-funcionais/2026-09-21/resumo-nivel{1,2,3}.json` |

&emsp;Este quadro deve ser atualizado conforme cada item for implementado e executado, até que todas as linhas de "Situação" na Seção 2 estejam preenchidas com aprovado/reprovado — único item ainda em aberto.

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

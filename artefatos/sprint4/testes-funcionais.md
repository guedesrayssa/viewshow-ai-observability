# Testes Funcionais — Planejamento

> **Status deste documento: PLANEJAMENTO.** Esta versão define **quais** serão os testes funcionais do projeto (identificador, objetivo, procedimento e resultado esperado), atendendo à issue de Messias Olivindo *"Definir quais vão ser os Testes Funcionais do Projeto"*. **Nenhum teste novo foi implementado ou executado como parte desta entrega.** Os campos "Resultado obtido" e "Situação" estão marcados como **a executar** em todos os itens; implementação, execução e evidências (capturas, brutos de `vitest`/`k6`) ficam para uma etapa futura da sprint.

## O que este documento é (e o que não é)

&emsp;Este artefato cobre os **requisitos funcionais (RF01–RF10)** definidos em [`sprint1/requisitos.md`](../sprint1/requisitos.md#2-requisitos-funcionais-rf): verifica se o sistema **faz** o que deveria — se uma função devolve o valor correto, se uma rota entrega o dado esperado, se um fluxo de negócio se comporta certo nos limites de entrada, e se isso continua verdadeiro sob carga.

&emsp;Ele **não** substitui nem duplica [`sprint3/testes-carga-inicial.md`](../sprint3/testes-carga-inicial.md), que cobre os **requisitos não funcionais (RNF01–RNF15)** — capacidade, latência (p95), disponibilidade, throughput. Onde a Seção 4 deste documento usa carga progressiva com a mesma ferramenta k6, o objetivo é **corretude da resposta sob concorrência** (dado certo, sem corrupção, sem efeito colateral), não desempenho; os números de capacidade da API atual (RNF09, RNF14) já estão medidos e classificados naquele artefato e são apenas referenciados aqui como contexto, sem repetir a análise.

## Sumário

1. [Testes Unitários](#1-testes-unitários)
2. [Testes de Integração](#2-testes-de-integração)
3. [Testes de Caso de Uso e Análise de Valor Limite](#3-testes-de-caso-de-uso-e-análise-de-valor-limite)
4. [Testes de Carga Funcional](#4-testes-de-carga-funcional)
5. [Convenção de evidências](#5-convenção-de-evidências)

---

## Objetivo geral

&emsp;Documentar o planejamento dos testes que verificarão os requisitos funcionais do sistema ARGUS/View Show — alvo `apps/backend/api` (monólito modular TypeScript, Express 5, DynamoDB), o mesmo escopo do artefato de RNF. A base de todo teste abaixo é código ou requisito que **já existe** no repositório: nenhum RF, caso de uso, rota ou métrica foi inventado para preencher a issue.

&emsp;A suíte atual (`npm test`, Vitest) tem 11 arquivos e roda **70 testes passando, 1 ignorado** (confirmado em [`sprint3/testes-carga-inicial.md`, RNF12](../sprint3/testes-carga-inicial.md#43-requisitos-validados-por-inspeção-ci-ou-execução-manual)). A Seção 1 e a Seção 2 apontam, teste a teste, o que já está coberto por essa suíte — para reaproveitar como evidência — e o que precisa ser escrito.

---

## 1. Testes Unitários

&emsp;Quatro testes unitários, cobrindo função/método isolado com pelo menos um caso válido e um caso de erro cada. Três das quatro já existem na suíte Vitest; o quarto expõe uma lacuna real (limite de paginação nunca testado nos seus extremos) que também alimenta a análise de valor limite da Seção 3.

### UT01 — `CursorCodec.encode` / `CursorCodec.decode`

| Campo | Descrição |
| --- | --- |
| Função testada | `CursorCodec` em [`src/modules/incidents/domain/cursor.ts`](../../apps/backend/api/src/modules/incidents/domain/cursor.ts) |
| RF relacionado | RF09 (consultas filtradas) e RF07 (dashboard com filtros cumulativos) — o cursor é o mecanismo de paginação de `GET /api/v1/incidents` |
| Já existe? | **Sim** — `tests/domain.test.ts:70`, `"encrypts cursors and binds them to filters"` |
| Pré-condições e dados de entrada | Segredo de 32+ caracteres para a chave AES-256-GCM; um par `(offset, fingerprint)` de filtros válido |
| Procedimento | 1. Instanciar `CursorCodec` com um segredo fixo. 2. `encode(20, "filter-a")` e conferir que o cursor não contém o texto do filtro em claro. 3. `decode(cursor, "filter-a")` deve devolver `20` (caso válido). 4. `decode(cursor, "filter-b")` (fingerprint errado) deve lançar `ServiceError` (caso de erro). 5. Adulterar um caractere do cursor e chamar `decode` novamente — deve lançar `ServiceError` |
| Resultado esperado | Caso válido: offset original devolvido sem vazar o filtro no cursor. Caso de erro: `ServiceError` (400) para fingerprint incompatível e para cursor adulterado — nunca um offset silenciosamente incorreto |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Saída de `npm test -- domain.test.ts` registrada em `assets/testes-funcionais/<data>/resultado-vitest-domain.txt` |

### UT02 — `CognitoPasswordAuthenticator.authenticate`

| Campo | Descrição |
| --- | --- |
| Função testada | `CognitoPasswordAuthenticator` em [`src/modules/auth/adapters/cognito-password-authenticator.ts`](../../apps/backend/api/src/modules/auth/adapters/cognito-password-authenticator.ts) |
| RF relacionado | RF04 (autenticação corporativa via provedor de identidade) |
| Já existe? | **Sim** — `tests/auth-password-login.test.ts:35` (login válido) e `tests/auth-password-login.test.ts:117` (mapeamento de erro) |
| Pré-condições e dados de entrada | Mock de `InitiateAuthFn` (substitui a chamada real ao Cognito); `clientId`/`clientSecret` de teste; um ID token JWT sintético com `email` e `cognito:groups` |
| Procedimento | 1. Caso válido: mock devolve `AuthenticationResult` com ID token contendo grupo `engineer`; chamar `authenticate({ username, password })` e conferir identidade, papel e tokens devolvidos. 2. Caso de erro: mock lança `NotAuthorizedException`; chamar `authenticate` e conferir que o retorno é `{ ok: false, reason: "invalid_credentials" }`, sem lançar exceção não tratada |
| Resultado esperado | Caso válido: `{ ok: true, identity: { role: "engineer", ... }, tokens: {...} }`. Caso de erro: falha classificada (`invalid_credentials`) e nunca uma sessão emitida a partir de credencial rejeitada pelo Cognito |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Saída de `npm test -- auth-password-login.test.ts` registrada em `assets/testes-funcionais/<data>/resultado-vitest-auth.txt` |

### UT03 — `PasswordLoginUseCases.login` (tradução de falha em HTTP)

| Campo | Descrição |
| --- | --- |
| Função testada | `PasswordLoginUseCases` em [`src/modules/auth/application/password-login-use-cases.ts`](../../apps/backend/api/src/modules/auth/application/password-login-use-cases.ts) |
| RF relacionado | RF04 — é a camada que a rota `POST /auth/login` chama para transformar o resultado do Cognito em uma resposta HTTP |
| Já existe? | **Sim** — `tests/auth-password-login.test.ts:179` (login válido) e `tests/auth-password-login.test.ts:211` (`it.each` com as 6 razões de falha) |
| Pré-condições e dados de entrada | Um `PasswordAuthenticatorPort` falso, parametrizado com cada `PasswordAuthOutcome` possível (`ok: true` e as 6 variantes de `ok: false`) |
| Procedimento | 1. Caso válido: port devolve `{ ok: true, identity, tokens }`; chamar `login(username, password)` e conferir que o resultado é `{ identity, tokens }`. 2. Caso de erro (repetir para as 6 razões): port devolve `{ ok: false, reason }`; chamar `login` e conferir que a promise rejeita com `{ status, code }` — por exemplo `invalid_credentials → 401/UNAUTHENTICATED`, `rate_limited → 429/RATE_LIMITED` |
| Resultado esperado | Login válido devolve identidade e tokens sem alteração. Cada razão de falha do Cognito mapeia para exatamente o par `(status, code)` documentado — nenhuma falha de autenticação deve escapar como 500 genérico |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Mesma saída de `npm test -- auth-password-login.test.ts` da UT02 |

### UT04 — `incidentsQuerySchema` (validação do parâmetro `limit`)

| Campo | Descrição |
| --- | --- |
| Função testada | `incidentsQuerySchema` em [`contracts/src/index.ts:275-304`](../../apps/backend/api/contracts/src/index.ts), campo `limit: z.coerce.number().int().min(1).max(100).default(20)` (linha 295) |
| RF relacionado | RF09 (consultas filtradas para análise de falhas críticas) — este é o schema que valida a query de `GET /api/v1/incidents` antes de qualquer lógica de negócio |
| Já existe? | **Parcial — a escrever.** `tests/contracts.test.ts:220-223` já testa que `limit: "10"` é coagido para o número `10`, mas **nenhum teste cobre os extremos do intervalo** (`min(1)`, `max(100)`) nem o caso de erro (`limit` fora do intervalo ou não numérico) |
| Pré-condições e dados de entrada | Nenhuma — teste puro de schema Zod, sem HTTP nem banco. Entradas: `{}` (ausente), `{ limit: "1" }`, `{ limit: "100" }`, `{ limit: "0" }`, `{ limit: "101" }`, `{ limit: "abc" }` |
| Procedimento | 1. Caso válido (ausente): `incidentsQuerySchema.parse({})` → `limit` deve ser `20` (default). 2. Caso válido (limite inferior): `parse({ limit: "1" })` → `limit === 1`. 3. Caso válido (limite superior): `parse({ limit: "100" })` → `limit === 100`. 4. Caso de erro (abaixo do limite): `parse({ limit: "0" })` deve lançar. 5. Caso de erro (acima do limite): `parse({ limit: "101" })` deve lançar. 6. Caso de erro (não numérico): `parse({ limit: "abc" })` deve lançar |
| Resultado esperado | Os três valores dentro do intervalo `[1, 100]` (incluindo os dois extremos) são aceitos e coagidos para `number`; os três valores fora do intervalo ou de tipo inválido lançam `ZodError`, impedindo que a query chegue ao `IncidentUseCases` com um `limit` inválido |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Teste novo a adicionar em `tests/contracts.test.ts`; saída de `npm test -- contracts.test.ts` registrada em `assets/testes-funcionais/<data>/resultado-vitest-contracts.txt` |

---

## 2. Testes de Integração

&emsp;Dois testes cruzando camadas diferentes: um já coberto pela suíte de integração HTTP existente, outro expondo uma lacuna real (persistência mockada, nunca exercitada contra um banco de verdade).

### IT01 — Camada HTTP (Express) × módulo de autenticação/sessão

| Campo | Descrição |
| --- | --- |
| Componentes verificados | `createApp` (Express, [`src/app.ts`](../../apps/backend/api/src/app.ts)) integrado de ponta a ponta com o módulo de auth real (`SessionCodec`, `IdentityUseCases`) — servidor HTTP real ouvindo em porta efêmera, requisição feita via `node:http` |
| RF relacionado | RF04 (autenticação corporativa: sessão válida libera acesso, ausência/invalidez bloqueia) |
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
| RF relacionado | RF01/RF02 (evento persistido fica disponível para consulta) e RF09 (consulta filtrada e paginada sobre dado realmente gravado) |
| Já existe? | **Não — a escrever.** `tests/dynamodb-adapters.test.ts` cobre os mesmos adaptadores, mas com `client.send` **inteiramente mockado** (`vi.fn(async () => ({ Items: [] }))`), então nenhum teste hoje grava e lê de um banco de verdade — a integração real nunca foi exercitada |
| Pré-condições e dados de entrada | DynamoDB Local em `127.0.0.1:18000` (`-inMemory -sharedDb`, mesma configuração usada em [`sprint3/testes-carga-inicial.md`, Tabela 12](../sprint3/testes-carga-inicial.md#61-ambiente-local-controlado)); tabela criada com o esquema de `apps/fullstack/dynamodb.tf` (`pk`/`sk`, GSI `trace-index`); `DYNAMODB_ENDPOINT` apontando para o local; alguns incidentes sintéticos gravados via `PutItem`/`seed-carga.cjs` |
| Procedimento | 1. Subir DynamoDB Local e criar a tabela operacional com o schema do Terraform. 2. Gravar N incidentes sintéticos (N > `limit` de teste, ex.: 5 incidentes com `limit=2`). 3. Instanciar `DynamoIncidentRepository` apontando para o endpoint local e `IncidentUseCases` com um `CursorCodec` real. 4. Chamar `listIncidents({ limit: 2 })`, guardar `nextCursor`. 5. Chamar novamente com o `cursor` recebido e conferir que a segunda página não repete nenhum item da primeira e é consistente com o total gravado |
| Resultado esperado | Os itens persistidos no DynamoDB real são lidos, convertidos para DTO (sem campos físicos `pk`/`sk`) e paginados corretamente: união das páginas = total gravado, sem duplicatas, `hasMore` e `nextCursor` coerentes com o fim da lista |
| Resultado obtido | a executar |
| Situação | a executar |
| Evidências / reprodução | Teste novo a adicionar em `tests/` (ex.: `tests/dynamodb-real.integration.test.ts`); log de execução e captura de `docker ps`/processo do DynamoDB Local em `assets/testes-funcionais/<data>/` |

---

## 3. Testes de Caso de Uso e Análise de Valor Limite

&emsp;Caso de uso escolhido: **consulta filtrada e paginada de incidentes** (RF09, rota `GET /api/v1/incidents`, exposta em [`src/http/public-routes.ts`](../../apps/backend/api/src/http/public-routes.ts) como `incidents`). É o único caso de uso do projeto com uma entrada numérica de faixa explícita e documentada em código: `limit` — inteiro entre **1 e 100**, padrão **20** (`incidentsQuerySchema`, `contracts/src/index.ts:295`) — combinada com um cursor opaco de paginação (`CursorCodec`, Seção 1/UT01) e com a regra de exclusividade entre `window` e o par `from`/`to` (`validateTemporalQuery`, `contracts/src/index.ts:251-262`).

### 3.1 Pré-condições e dados de entrada comuns

- Sessão autenticada válida (cookie emitido por `SessionCodec`) — sem ela a rota responde `401` antes de qualquer validação de query (comportamento já confirmado no RNF04, [`sprint3/testes-carga-inicial.md`, Seção 7.5](../sprint3/testes-carga-inicial.md#75-controle-de-acesso)), então este caso de uso assume sessão válida e testa o que acontece **depois** da guarda de sessão.
- Base de incidentes conhecida (ex.: N=150 incidentes sintéticos gravados via `scripts/seed-carga.cjs` ou equivalente), para que `hasMore`/`nextCursor` tenham um valor determinístico em cada consulta.

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
- **E4 — sessão ausente/inválida:** `401`, fora do escopo desta análise de valor limite (já coberto por RNF04), citado aqui só para registrar a ordem das guardas (sessão → schema → cursor → negócio).

### 3.5 Pós-condições

- A união de todas as páginas percorridas com o mesmo conjunto de filtros é igual ao total de incidentes que atendem ao filtro, sem duplicatas e sem lacunas.
- Nenhuma resposta traz mais itens do que o `limit` solicitado (ou o padrão, quando omitido).
- `page.hasMore=false` se e somente se não existir próxima página; `page.nextCursor=null` nesse caso.
- Nenhum campo físico de persistência (`pk`, `sk`, `ttl`) vaza no corpo da resposta (mesma regra validada em `tests/domain.test.ts:100-125` para o DTO de incidente).

### 3.6 Tabela de rastreabilidade — fluxos/condições × casos de teste

| Fluxo/condição | Caso de teste | Entrada | Resultado esperado | Situação |
| --- | --- | --- | --- | --- |
| Fluxo principal | CT-01 | `GET /api/v1/incidents?window=1h` (sem `limit`) | `page.limit=20` (default); ≤ 20 itens; página coerente com o total | a executar |
| A1 — paginação subsequente | CT-02 | Repetir CT-04 (abaixo) com `cursor` da resposta anterior | Segunda página sem itens repetidos da primeira; `hasMore` correto | a executar |
| A2 — janela absoluta | CT-03 | `from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z` (sem `window`) | `200`, itens restritos à janela informada | a executar |
| A3 — facetas combinadas | CT-04 | `deviceType=android&limit=50` | `200`, `page.limit=50`, itens só de `deviceType=android` | a executar |
| Limite — valor mínimo válido | CT-05 | `limit=1` | `200`, exatamente 1 item (se houver dado), `page.limit=1` | a executar |
| Limite — abaixo do mínimo | CT-06 | `limit=0` | Erro de validação (400), nenhuma consulta ao banco | a executar |
| Limite — valor máximo válido | CT-07 | `limit=100` | `200`, até 100 itens, `page.limit=100` | a executar |
| Limite — acima do máximo | CT-08 | `limit=101` | Erro de validação (400) | a executar |
| Limite — tipo inválido | CT-09 | `limit=abc` | Erro de validação (400) | a executar |
| E1 — `window` + `from`/`to` juntos | CT-10 | `window=1h&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z` | Erro de validação (400), mensagem "from e to devem ser enviados juntos..." | a executar |
| E2 — cursor de outro filtro | CT-11 | `cursor` obtido com `deviceType=android`, reenviado com `deviceType=ios` | `400` (`VALIDATION_ERROR`, "O cursor é inválido para estes filtros.") | a executar |
| E4 — sem sessão | CT-12 | Mesma chamada de CT-01, sem cookie | `401`, corpo sem dado de incidente | a executar |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026), com base em `contracts/src/index.ts` e `src/modules/incidents/`.</sup>

</div>

---

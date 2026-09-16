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

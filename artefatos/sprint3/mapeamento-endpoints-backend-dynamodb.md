# Mapeamento de endpoints do backend × DynamoDB

Levantamento de **como a API opera hoje**, lido do código — não da documentação.
Objetivo: confirmar se as leituras estão corretas e registrar a arquitetura de
dados **como ela de fato é**.

- **Escopo:** `apps/backend/api/src` no branch `feat/visao-geral-dashboard-summary`
  (commit `bc2a432`).
- **Data do levantamento:** 2026-09-03.
- **Método:** leitura de `src/app.js`, `src/routes/*.js`, `src/services/*.js`,
  `src/db/*.js`, `src/middleware/requireAuth.js`, `src/auth/session.js`,
  `src/orchestrator/index.js`, `src/agent/index.js`, `scripts/seed.js`,
  `scripts/reset.js` e `apps/infra/dynamodb.tf` (definição executável das tabelas).
- **Não houve alteração de código.** Este é um documento de levantamento.

> Referências de contrato-alvo (para contraste, não é o que está implementado):
> `artefatos/contratos/dashboard-api-contract.md` e
> `artefatos/contratos/dashboard-api-gap-analysis.md`.

---

## 1. Arquitetura de dados como ela é hoje

### 1.1 Tabelas

| Tabela | Env var | Chave primária | GSI | TTL |
|---|---|---|---|---|
| `monitoracao-operacional` | `OPERATIONAL_TABLE_NAME` | `pk` (S, HASH) + `sk` (S, RANGE) | `trace-index`: HASH `trace_id` (S), RANGE `sk` (S), projeção **ALL** | atributo `ttl` (epoch s), habilitado |
| `monitoracao-golden-set` | `GOLDEN_SET_TABLE_NAME` | `case_id` (S, HASH) — **sem sort key** | nenhum | nenhum |

Fonte do esquema: `apps/infra/dynamodb.tf` (as tabelas foram criadas à mão no
console na Sprint 2; o Terraform é a primeira definição executável, derivada do
código que lê/escreve).

### 1.2 Famílias de item em `monitoracao-operacional`

Convenção de chaves centralizada em **`src/db/keys.js`** (só cobre incidente /
evidência / hipótese):

| Família | `pk` | `sk` | `trace_id` | `ttl` | Outros atributos |
|---|---|---|---|---|---|
| **Incidente** | `INC#<YYYY-MM-DDTHH>` (hora UTC do início) | `INCIDENT#<id>` | `<id>` | sim | `id, urgency, title, segment, devices, startedAt, startedMinutesAgo, component, deviceType, region, appVersion, sessions, timeAgo, status, statusLabel` (seed) |
| **Evidência** | mesmo bucket do incidente | `INCIDENT#<id>#EVIDENCE#<seq:3>` | `<id>` | sim | `incidentId, type, description, source, strength, capturedAt` |
| **Hipótese** | mesmo bucket do incidente | `INCIDENT#<id>#HYPOTHESIS#<seq:10>` | `<id>` | sim | `incidentId, text, score, source` (seed) / `diagnosisSource` (orquestrador), `createdAt`; após revisão: `reviewStatus, reviewedBy, reviewedAt` |
| **Usuário** *(fora de `keys.js`)* | `USER#<email-normalizado>` | `PROFILE` | — | **não** | `email, name, passwordHash` (`<salt>:<scrypt-hex>`), `createdAt` |

`keys.js` fornece:

- `hourBucket(date)` → `INC#` + `date.toISOString().slice(0,13)` (ex.: `INC#2026-09-03T14`).
- `incidentSk(id)` → `INCIDENT#<id>`.
- `evidenceSk(id, seq)` → `INCIDENT#<id>#EVIDENCE#<seq>` com `seq` preenchido a 3 dígitos.
- `hypothesisSk(id, seq)` → `INCIDENT#<id>#HYPOTHESIS#<seq>` com `seq` preenchido a 10 dígitos.
- `itemTypeFromSk(sk)` → `split("#")`; `length === 2` ⇒ `INCIDENT`; `parts[2] === "EVIDENCE"` ⇒ `EVIDENCE`; `parts[2] === "HYPOTHESIS"` ⇒ `HYPOTHESIS`; senão `UNKNOWN`.

> **`keys.js` não conhece a família `USER#` nem a tabela `monitoracao-golden-set`.**
> A chave de usuário é montada localmente em `src/services/userService.js`
> (`userKey()`), e a chave do golden set é montada em
> `src/services/goldenSetService.js` (`buildSignature()` →
> `"<component>#<deviceType>#<region>"`).

### 1.3 Famílias de item em `monitoracao-golden-set`

| `case_id` | Outros atributos |
|---|---|
| `<component>#<deviceType>#<region>` (assinatura determinística) | `incident_signature`, `expected_hypothesis`, `expected_score`, `curated_by`, `curated_at`, `source_incident_id` (só quando gravado por `promoteCase`) |

### 1.4 Portas de acesso e operações DynamoDB efetivamente usadas

| Módulo | Operações | Observação |
|---|---|---|
| `src/db/operationalTable.js` | `Query`, `PutItem`, `UpdateItem` | Sem `GetItem`, `BatchGetItem`, `TransactWriteItems`, `Scan` |
| `src/db/goldenSetTable.js` | `GetItem`, `Query` (nunca chamado por rota), `PutItem` (só via `putCurated`) | `put`/`update`/`delete` genéricos **não são exportados** — barreira estrutural do ADR-002 |
| `src/services/userService.js` | `GetItem`, `PutItem` (com `ConditionExpression`) direto no `documentClient` | **Não passa por `operationalTable.js`** apesar de ser a mesma tabela — fura o ADR-004; tem fallback para `Map` em memória |
| `scripts/reset.js` (não é rota) | `Scan` + `DeleteItem` | Único `Scan` do backend |

Nenhuma rota usa `BatchGetItem` ou `TransactWriteItems`.

---

## 2. Inventário de rotas

Montagem em `src/app.js`:

| # | Método + caminho | Router | `requireAuth` | Lê banco | Escreve banco |
|---|---|---|:--:|:--:|:--:|
| 1 | `GET /health` | `health.js` | não | — | — |
| 2 | `POST /auth/login` | `auth.js` | não | `GetItem` operacional (`USER#`) | — |
| 3 | `POST /auth/register` | `auth.js` | não | `GetItem` operacional (`USER#`) | `PutItem` operacional (`USER#`) |
| 4 | `GET /auth/sso` | `auth.js` | não | — | — |
| 5 | `GET /api/v1/incidents` | `incidents.js` | não | `Query` × N buckets (tabela base) | — |
| 6 | `GET /api/v1/incidents/:id` | `incidents.js` | não | `Query` GSI `trace-index` | — |
| 7 | `GET /api/v1/incidents/:id/evidence` | `incidents.js` | não | `Query` GSI `trace-index` | — |
| 8 | `GET /api/v1/incidents/:id/hypothesis` | `incidents.js` | não | `Query` GSI `trace-index` | — |
| 9 | `PATCH /api/v1/incidents/:id/hypothesis/review` | `incidents.js` | **sim** | `Query` GSI `trace-index` (×1 ou ×2) | `UpdateItem` operacional **+** `PutItem` golden-set (só se `confirmed`) |
| 10 | `POST /api/v1/incidents/:id/diagnose` | `incidents.js` | não | `Query` GSI `trace-index` (×2) + `GetItem` golden-set | `PutItem` operacional (hipótese) |
| 11 | `GET /api/v1/golden-set` | `goldenSet.js` | não | `GetItem` golden-set | — |
| 12 | `POST /api/v1/ml/analyze` | `ml.js` | não | — (mock) | — |
| 13 | `GET /api/v1/dashboard/summary` | `dashboard.js` | não | `Query` × 25 buckets (tabela base) | — |

**Só a rota 9 exige autenticação.** As rotas 3, 9 e 10 escrevem no banco; apenas
a 9 está protegida.

---

## 3. Detalhe rota a rota

### 1. `GET /health`

- **Request:** nada.
- **Response 200:** `{ "status": "ok" }`.
- **Erros:** nenhum (síncrono, sem I/O).
- **Banco:** não lê nem escreve.
- **Auth:** não.

---

### 2. `POST /auth/login`

- **Request — body** (`application/json`):
  | Campo | Tipo | Obrigatório |
  |---|---|---|
  | `email` | string | sim (de fato) |
  | `password` | string | sim (de fato) |

  `req.body || {}` — body ausente não dá 400, cai como credenciais inválidas.
- **Response 200:** `{ "status": "ok", "name": string | null }` + header
  `Set-Cookie: session=<base64url(email)>.<hmac-sha256>` (`httpOnly`, `sameSite=lax`,
  `maxAge` 8 h, `secure` só em produção). `name` vem preenchido apenas para conta
  registrada; para o usuário fixo de demonstração é `null`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 401 | `{ error: { message: "Credenciais inválidas" } }` | não é o usuário fixo (`AUTH_USER_EMAIL`/`AUTH_USER_PASSWORD`) **e** `userService.authenticate` devolveu `null` (conta inexistente ou senha errada) |

  Não há 400, 409 nem 500 neste handler. Se o DynamoDB estiver inacessível,
  `findUser` cai no `Map` em memória e o resultado ainda é 200/401.
- **Leitura no banco:** `userService.authenticate(email, password)` →
  `findUser(email)` → **`GetItem`** em `monitoracao-operacional`,
  `Key = { pk: "USER#" + normalizeEmail(email), sk: "PROFILE" }`.
  Fallback: `memoryUsers.get(normalized)` se o `GetCommand` lançar.
- **Escrita no banco:** nenhuma.
- **`keys.js`:** **não usado.** A chave `USER#<email>` / `PROFILE` é montada em
  `userService.userKey()`, fora da convenção de `keys.js`.
- **Auth:** não (é a rota que emite a sessão).

---

### 3. `POST /auth/register`

- **Request — body:**
  | Campo | Tipo | Regra |
  |---|---|---|
  | `name` | string | não-vazio após `trim` |
  | `email` | string | casar `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
  | `password` | string | comprimento ≥ 8 |
- **Response 201:** `{ "status": "ok", "name": string }` + `Set-Cookie: session=…`
  (abre a sessão já no cadastro).
- **Erros (nesta ordem):**
  | HTTP | Código-mensagem | Quando |
  |---|---|---|
  | 400 | `"Informe o seu nome."` | `name` vazio |
  | 400 | `"Digite um e-mail válido."` | `email` não casa o padrão |
  | 400 | `"A senha precisa de pelo menos 8 caracteres."` | `password.length < 8` |
  | 409 | `"Este e-mail já está registrado."` | `normalizeEmail(email) === AUTH_USER_EMAIL` (colide com o usuário fixo) |
  | 409 | `"Este e-mail já está registrado."` | `userService.createUser` devolveu `null` — e-mail já existe (via `findUser` **ou** `ConditionalCheckFailedException` no `PutItem`) |
  | 500 | `"Falha ao criar a conta"` | `createUser` lançou exceção não prevista |
- **Leitura no banco:** `createUser` → `findUser(email)` → **`GetItem`**
  `monitoracao-operacional`, `Key = { pk: "USER#<email>", sk: "PROFILE" }`
  (+ fallback `Map`).
- **Escrita no banco:** `createUser` → **`PutItem`** `monitoracao-operacional`,
  `Item = { pk: "USER#<email>", sk: "PROFILE", email, name, passwordHash: "<salt>:<scrypt-hex>", createdAt: <ISO> }`,
  `ConditionExpression: "attribute_not_exists(pk)"`.
  - `ConditionalCheckFailedException` ⇒ devolve `null` ⇒ 409.
  - Qualquer outro erro ⇒ `warnMemory` + grava em `memoryUsers` (o handler devolve
    201 mesmo sem o item ter chegado ao DynamoDB).
- **`keys.js`:** **não usado** (família `USER#`).
- **Auth:** não.

---

### 4. `GET /auth/sso`

- **Request:** nada.
- **Response:** **501** `{ error: { message: "SSO ainda não implementado nesta fase" } }` — sempre.
- **Banco:** não. **Auth:** não.

---

### 5. `GET /api/v1/incidents`

- **Request — query string:**
  | Parâmetro | Tipo | Obrigatório | Regra |
  |---|---|---|---|
  | `window` | string | não | `"15m"`, `"30m"`, `"1h"`, `"24h"` (aliases) **ou** número puro de minutos. Qualquer outra coisa (inclusive `"6h"`, `"45m"`) → `NaN` → **default 360 min (6 h)** |
  | `deviceType` | string | não | igualdade exata contra `incident.deviceType` |
  | `region` | string | não | igualdade exata contra `incident.region` |
  | `appVersion` | string | não | igualdade exata contra `incident.appVersion` |
- **Response 200:**
  ```json
  { "incidents": [ { "pk": "INC#2026-09-03T14", "sk": "INCIDENT#falhas-reproducao-tvs-lg",
                     "trace_id": "falhas-reproducao-tvs-lg", "ttl": 1756900000,
                     "id": "falhas-reproducao-tvs-lg", "urgency": "P1",
                     "title": "Falhas de reprodução em TVs LG", "segment": "12,4 mil sessões · Nordeste · webOS 6.0",
                     "devices": 8420, "startedAt": "09:18", "startedMinutesAgo": 12,
                     "component": "Player", "deviceType": "Smart TV", "region": "Nordeste",
                     "appVersion": "App 4.2.1", "sessions": "12,4 mil sessões",
                     "timeAgo": "há 18 min", "status": "critical", "statusLabel": "Crítico" } ] }
  ```
  Item **cru do DynamoDB** (inclui `pk`, `sk`, `trace_id`, `ttl`). Ordenação
  ascendente por `startedMinutesAgo`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 500 | `{ error: { message: "Falha ao listar incidentes" } }` | qualquer exceção nos `Query` |

  **Não há 400** para `window` inválido (cai no default). **Não há 404** (lista
  vazia é 200 `{ "incidents": [] }`).
- **Leitura no banco:** `evidenceService.listIncidents(filters)`:
  1. `parseWindowMinutes(window)` → minutos.
  2. `bucketsForWindow` → `hours = max(1, ceil(windowMinutes/60) + 1)` buckets
     `INC#<hora>`, contando de trás para frente a partir de **`new Date()` (agora)**.
  3. Para cada bucket, **`Query`** na tabela base:
     `KeyConditionExpression = "pk = :pk AND begins_with(sk, :prefix)"`,
     `:pk = "INC#<hora>"`, `:prefix = "INCIDENT#"`.
  4. `flat()` + `filter(itemTypeFromSk(sk) === "INCIDENT")` (descarta evidência e
     hipótese, que também começam por `INCIDENT#`) + `matchesFilters` + `sort`.
- **Escrita no banco:** nenhuma.
- **`keys.js`:** `hourBucket` (monta `:pk`) e `itemTypeFromSk` (classifica).
  Padrão de `pk`/`sk` **bate** com `keys.js`. Ressalvas em §4 (itens **A**, **B**, **C**, **J**).
- **Auth:** não.

---

### 6. `GET /api/v1/incidents/:id`

- **Request:** parâmetro de URL `id` (slug do incidente). Sem query, sem body.
- **Response 200:** objeto único = item de incidente **cru** (mesma forma da rota 5,
  sem o wrapper `incidents`).
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 404 | `{ error: { message: "Incidente não encontrado" } }` | `bundle.incident === null` |
  | 500 | `{ error: { message: "Falha ao buscar incidente" } }` | exceção no `Query` |
- **Leitura no banco:** `evidenceService.getIncidentById` → `getIncidentBundle` →
  **`Query`** no **GSI `trace-index`**:
  `IndexName = "trace-index"`, `KeyConditionExpression = "trace_id = :id"`,
  `:id = req.params.id`. Todos os itens do incidente compartilham `trace_id`;
  seleciona o de `itemTypeFromSk(sk) === "INCIDENT"`.
- **Escrita no banco:** nenhuma.
- **`keys.js`:** `itemTypeFromSk`. GSI `trace-index` **bate** com `dynamodb.tf`.
  Ressalva **C** em §4.
- **Auth:** não.

---

### 7. `GET /api/v1/incidents/:id/evidence`

- **Request:** parâmetro de URL `id`.
- **Response 200:** `{ "evidence": [ { "pk": "…", "sk": "INCIDENT#<id>#EVIDENCE#001",
  "trace_id": "<id>", "ttl": …, "incidentId": "<id>", "type": "log",
  "description": "…", "source": "Player", "strength": "forte",
  "capturedAt": "<ISO>" } ] }` — itens **crus**, filtrados por
  `itemTypeFromSk === "EVIDENCE"`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 500 | `{ error: { message: "Falha ao buscar evidências" } }` | exceção no `Query` |

  **Não há 404** — incidente inexistente devolve 200 `{ "evidence": [] }`.
- **Leitura no banco:** `getEvidenceByIncidentId` → `getIncidentBundle` →
  **`Query`** GSI `trace-index` por `trace_id`.
- **Escrita:** nenhuma.
- **`keys.js`:** `itemTypeFromSk`. Bate.
- **Auth:** não.

---

### 8. `GET /api/v1/incidents/:id/hypothesis`

- **Request:** parâmetro de URL `id`.
- **Response 200:** a **hipótese mais recente** (objeto único, cru). Formas possíveis:
  - do seed: `{ pk, sk: "INCIDENT#<id>#HYPOTHESIS#0000000001", trace_id, ttl, incidentId, text, score, source: "seed", createdAt }`;
  - do orquestrador: `{ …, text, score, diagnosisSource: "golden-set"|"agent", createdAt }`;
  - após revisão: acrescenta `reviewStatus`, `reviewedBy`, `reviewedAt`.
  "Mais recente" = maior `sk` em comparação lexicográfica entre os itens `HYPOTHESIS`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 404 | `{ error: { message: "Nenhuma hipótese registrada para este incidente" } }` | `bundle.hypotheses` vazio |
  | 500 | `{ error: { message: "Falha ao buscar hipótese" } }` | exceção no `Query` |
- **Leitura no banco:** `getLatestHypothesis` → `getIncidentBundle` → **`Query`**
  GSI `trace-index` por `trace_id`.
- **Escrita:** nenhuma.
- **`keys.js`:** `itemTypeFromSk`; a ordenação assume `hypothesisSk` com largura
  fixa (10 dígitos) para que ordem lexicográfica == cronológica. Ressalva **E** em §4.
- **Auth:** não.

---

### 9. `PATCH /api/v1/incidents/:id/hypothesis/review` — **requireAuth**

- **Request:**
  - parâmetro de URL `id`;
  - header `Cookie: session=<...>` **válido** (HMAC-SHA256, `AUTH_COOKIE_SECRET`);
  - body: `{ "status": "confirmed" | "refuted" }`.
- **Response 200:** a hipótese atualizada (`ReturnValues: "ALL_NEW"`), incluindo
  `reviewStatus = <status>`, `reviewedBy = <e-mail da sessão>`, `reviewedAt = <ISO>`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 401 | `{ error: { message: "Sessão inválida ou ausente" } }` | `requireAuth`: cookie `session` ausente ou HMAC não confere |
  | 400 | `{ error: { message: "status deve ser 'confirmed' ou 'refuted'" } }` | `status` ∉ `{confirmed, refuted}` (inclui body ausente) |
  | 404 | `{ error: { message: "Nenhuma hipótese registrada para este incidente" } }` | `reviewHypothesis` devolveu `null` (sem hipótese) |
  | 500 | `{ error: { message: "Falha ao revisar hipótese" } }` | qualquer exceção (inclui falha no `promoteCase`) |
- **Leitura no banco:**
  1. `evidenceService.reviewHypothesis` → `getLatestHypothesis` → **`Query`** GSI
     `trace-index` por `trace_id`.
  2. **Só se `status === "confirmed"`:** `evidenceService.getIncidentById` →
     **`Query`** GSI `trace-index` por `trace_id` (2ª vez, para obter o incidente e
     montar a assinatura).
- **Escrita no banco:**
  1. `operationalTable.update` → **`UpdateItem`** em `monitoracao-operacional`,
     `Key = { pk: hypothesis.pk, sk: hypothesis.sk }` (o `pk`/`sk` da tabela base
     vêm no item projetado pelo GSI, cuja projeção é `ALL`),
     `UpdateExpression = "SET reviewStatus = :status, reviewedBy = :reviewedBy, reviewedAt = :reviewedAt"`.
     **Sem `ConditionExpression`.**
  2. **Só se `status === "confirmed"`:** `goldenSetService.promoteCase` →
     `goldenSetTable.putCurated` → **`PutItem`** em `monitoracao-golden-set`,
     `Item = { case_id: "<component>#<deviceType>#<region>", incident_signature: <mesma>, expected_hypothesis: hypothesis.text, expected_score: hypothesis.score, curated_by: <e-mail da sessão>, curated_at: <ISO>, source_incident_id: incident.id }`.
     Sobrescreve o item inteiro (sem condição).
- **`keys.js`:** `itemTypeFromSk` (via `getLatestHypothesis`); ordenação assume
  `hypothesisSk` de largura fixa. A chave do golden set **não** vem de `keys.js` —
  vem de `goldenSetService.buildSignature`. Ressalvas **D** e **E** em §4.
- **Auth:** **sim** (`requireAuth`). É a única rota protegida — justamente porque,
  com `confirmed`, promove o caso ao golden set (ADR-005).

---

### 10. `POST /api/v1/incidents/:id/diagnose`

- **Request:** parâmetro de URL `id`. Body **ignorado** (`orchestrator.diagnose`
  só recebe `id`). **Sem `requireAuth`.**
- **Response 200:**
  ```json
  { "incidentId": "<id>", "hypothesis": "<texto>", "score": 0.6,
    "evidence": [ /* itens crus de evidência */ ],
    "diagnosisSource": "golden-set" | "agent",
    "explanation": "<texto>", "explanationSource": "template" | "bedrock" }
  ```
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 404 | `{ error: { message: "Incidente não encontrado" } }` | `bundle.incident === null` |
  | 500 | `{ error: { message: "Falha ao diagnosticar incidente" } }` | exceção (Bedrock nunca lança — tem fallback por template) |
- **Leitura no banco:**
  1. `evidenceService.getIncidentBundle` → **`Query`** GSI `trace-index` por `trace_id`.
  2. `goldenSetService.findMatchingCase(signature)` → `goldenSetTable.get` →
     **`GetItem`** em `monitoracao-golden-set`, `Key = { case_id: "<component>#<deviceType>#<region>" }`.
  3. Dentro de `saveHypothesis`: `getIncidentById` → **`Query`** GSI `trace-index`
     por `trace_id` (2ª vez).
- **Escrita no banco:** `evidenceService.saveHypothesis` → `operationalTable.put`
  → **`PutItem`** em `monitoracao-operacional`,
  `Item = { pk: incident.pk, sk: "INCIDENT#<id>#HYPOTHESIS#<epoch:10>", trace_id: <id>, ttl: incident.ttl, incidentId: <id>, text: <hipótese>, score: <número>, diagnosisSource: "golden-set"|"agent", createdAt: <ISO> }`.
  `seq` = `Math.floor(Date.now()/1000)` (epoch em segundos, 10 dígitos).
- **`keys.js`:** `hypothesisSk` (monta o `sk`), `hourBucket` (indireto — reusa
  `incident.pk`), `itemTypeFromSk`. Padrão **bate** com `keys.js`. Ressalva **F** em §4.
- **Auth:** não — **mas escreve no banco** (ver **F**).

---

### 11. `GET /api/v1/golden-set`

- **Request — query string:**
  | Parâmetro | Tipo | Obrigatório | Regra |
  |---|---|---|---|
  | `signature` | string | **sim** | formato `<component>#<deviceType>#<region>`, ex.: `Player#Smart TV#Nordeste` (URL-encoded) |
- **Response 200:** item cru do golden set:
  `{ case_id, incident_signature, expected_hypothesis, expected_score, curated_by, curated_at, [source_incident_id] }`.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 400 | `{ error: { message: "Informe ?signature=<component>#<deviceType>#<region>" } }` | `signature` ausente |
  | 404 | `{ error: { message: "Nenhum caso golden set para essa assinatura" } }` | `GetItem` não achou |
  | 500 | `{ error: { message: "Falha ao consultar golden set" } }` | exceção |
- **Leitura no banco:** `goldenSetService.findMatchingCase(signature)` →
  `goldenSetTable.get({ case_id: signature })` → **`GetItem`** em `monitoracao-golden-set`.
- **Escrita:** nenhuma.
- **`keys.js`:** não envolvido. Chave = string de assinatura literal, hash key
  `case_id` (`dynamodb.tf`).
- **Auth:** não.

---

### 12. `POST /api/v1/ml/analyze`

- **Request — body:** qualquer objeto JSON.
- **Response 200 (mock fixo):**
  ```json
  { "anomalyScore": 0.82, "label": "anomaly", "confidence": 0.6,
    "model": "mock-v0", "receivedInputKeys": ["<chaves do body>"] }
  ```
- **Erros:** nenhum tratado (`mlService.analyze` é puro e não lança).
- **Banco:** não lê nem escreve.
- **Auth:** não.

---

### 13. `GET /api/v1/dashboard/summary`

- **Request:** **nenhum parâmetro é lido** (o handler ignora query/body; o contrato-alvo
  pede `window`, `deviceType`, etc., não implementados).
- **Response 200:**
  ```json
  { "stats": [
      { "id": "affected-sessions",  "label": "Sessões afetadas",   "value": <Σ incident.devices>,           "format": "compact", "accent": "info" },
      { "id": "active-incidents",   "label": "Incidentes ativos",  "value": <nº de status !== "success">,   "format": "integer", "accent": "warning" },
      { "id": "critical-incidents", "label": "Incidentes críticos","value": <nº de status === "critical">,  "format": "integer", "accent": "critical" }
    ],
    "recentIncidents": [ /* os 5 primeiros de listIncidents({window:"24h"}), itens crus */ ] }
  ```
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 500 | `{ error: { message: "Falha ao montar resumo do dashboard" } }` | exceção nos `Query` |
- **Leitura no banco:** `evidenceService.listIncidents({ window: "24h" })` →
  `1440` min → `hours = ceil(1440/60)+1 = 25` buckets → **25 `Query`s** na tabela base
  (`pk = "INC#<hora>" AND begins_with(sk, "INCIDENT#")`), contando de agora para trás.
- **Escrita:** nenhuma.
- **`keys.js`:** `hourBucket`, `itemTypeFromSk`. Padrão **bate**. Ressalvas **A**, **H** em §4.
- **Auth:** não.

---

## 4. Aderência a `src/db/keys.js` e inconsistências encontradas

Resumo por rota:

| Rota | Padrão de leitura bate com `keys.js`? | Ressalvas |
|---|---|---|
| `GET /health`, `GET /auth/sso`, `POST /ml/analyze` | n/a (não tocam banco) | — |
| `POST /auth/login`, `POST /auth/register` | **Fora de `keys.js`** — família `USER#`/`PROFILE` montada em `userService.js` | **G** |
| `GET /api/v1/incidents` | Sim (`pk = INC#<hora>`, `sk` por `begins_with("INCIDENT#")`) | **A**, **B**, **C**, **I**, **J** |
| `GET /api/v1/incidents/:id` `/evidence` `/hypothesis` | Sim (GSI `trace-index`, `itemTypeFromSk`) | **C**, **E** (só `/hypothesis`), **I** |
| `PATCH …/hypothesis/review` | Parcial — leitura via `keys.js`; chave do golden set fora de `keys.js` | **C**, **D**, **E** |
| `POST …/diagnose` | Sim (`hypothesisSk`, GSI `trace-index`, `GetItem` golden set por assinatura) | **C**, **E**, **F** |
| `GET /api/v1/golden-set` | n/a para `keys.js`; usa `case_id` = assinatura (`dynamodb.tf`) | — |
| `GET /api/v1/dashboard/summary` | Sim | **A**, **C**, **H**, **I** |

### A — Janela temporal × bucket de hora: a leitura depende de **há quanto tempo o `seed` rodou**  · impacto ALTO

`pk` codifica a **hora UTC absoluta** do início do incidente. No seed:
`hourBucket(new Date(Date.now() - incident.startedMinutesAgo * 60000))`, calculado
**no instante da carga**. O campo `startedMinutesAgo` é um literal congelado
(`12`, `38`, `54`, `92`) — não anda com o relógio.

`bucketsForWindow` recalcula os buckets a partir de `new Date()` **no instante da
requisição**. Conforme o tempo real passa depois do seed, o conjunto de buckets
consultados desliza para frente e **deixa de cobrir a hora congelada no `pk` do
incidente**.

Efeito:

- `GET /api/v1/incidents` (janela default 6 h → 7 buckets): os incidentes somem da
  listagem cerca de **6 h depois do `npm run seed`**, embora os dados digam
  "há 12 minutos".
- `GET /api/v1/dashboard/summary` (`window: "24h"` → 25 buckets): "Sessões
  afetadas", "Incidentes ativos" e "Incidentes críticos" caem a **zero** cerca de
  **25 h depois do seed**.

Este é o candidato mais provável para o sintoma **"ele não tá lendo de maneira
correta"**: a leitura está tecnicamente certa para a convenção de chave, mas o
resultado depende do relógio de parede, não do dado. Rodar `npm run reset &&
npm run seed` "conserta" temporariamente — o que confirma o diagnóstico.

### B — O filtro de janela é só por bucket de hora; o item nunca é filtrado pelo timestamp  · impacto MÉDIO/ALTO

`listIncidents` **nunca** compara `startedMinutesAgo` (nem qualquer timestamp) com
`windowMinutes`. Ele só escolhe **quantos buckets de hora** varrer
(`hours = ceil(windowMinutes/60) + 1`) e devolve tudo que houver neles.

Consequências:

- `window=15m` varre **2 buckets** (hora atual + anterior) e devolve incidentes de
  **até ~2 h atrás**, sem recorte de 15 min.
- `window=15m`, `window=30m` e `window=1h` retornam praticamente o mesmo conjunto
  (diferem só na contagem de buckets, não num corte real de minutos).
- Não existe limite superior real por janela — só o número de buckets.

### C — `itemTypeFromSk` pressupõe `id` sem `#` (fragilidade latente)  · impacto MÉDIO

`itemTypeFromSk` faz `sk.split("#")` e decide por `parts.length === 2` e
`parts[2]`. Isso só funciona enquanto o `id` do incidente for **um único segmento
sem `#`**. Os `id`s do seed são slugs (`falhas-reproducao-tvs-lg`), então hoje está
ok.

Se um `id` algum dia contiver `#` (ou vier o "id canônico opaco" previsto no
contrato-alvo), o `sk` de incidente `INCIDENT#a#b` passa a ter `parts.length === 3`
e `parts[2] === "b"` → classificado como **`UNKNOWN`** → o incidente **desaparece**
de toda listagem (`listIncidents` filtra `=== "INCIDENT"`) e de todo bundle. O
comentário em `keys.js` documenta a convenção, mas o código não a defende.

### D — `PATCH …/hypothesis/review` grava sem escrita condicional  · impacto MÉDIO

`operationalTable.update` não recebe `ConditionExpression`:

- Dois revisores concorrentes → o último `UpdateItem` vence silenciosamente
  (o contrato §8 pede `expectedVersion` e `REVIEW_VERSION_CONFLICT` — não existe
  versionamento).
- Se o item da hipótese tiver expirado por TTL entre o `Query` no GSI e o
  `UpdateItem`, o `UpdateItem` **faz upsert**: cria um item novo só com
  `{ pk, sk, reviewStatus, reviewedBy, reviewedAt }`, sem `incidentId`/`text`/`score`.

### E — `getLatestHypothesis` pode não apontar para a hipótese revisada  · impacto BAIXO/MÉDIO

A revisão age sobre a hipótese de maior `sk`. Rodar `POST …/diagnose` de novo
depois de uma revisão insere uma hipótese mais nova (seq = epoch) → a hipótese
revisada deixa de ser a "última"; `GET …/hypothesis` e uma revisão seguinte
passam a agir sobre a nova, ainda não revisada. Não há a noção de "hipóteses
pertencentes à mesma execução de diagnóstico" (confirmado no gap-analysis §8).

### F — `POST …/diagnose` escreve no banco sem `requireAuth`  · impacto MÉDIO

Chama `saveHypothesis` → `PutItem` em `monitoracao-operacional`. Um chamador não
autenticado consegue inserir itens `HYPOTHESIS`. Só `PATCH …/review` está atrás de
`requireAuth`. O gap-analysis (§5.2, §8) recomenda tratar `/diagnose` como
operação interna.

### G — Contas de usuário fora da convenção e apagadas pelo `reset`  · impacto BAIXO

`userService` monta `pk = USER#<email>`, `sk = "PROFILE"` direto, sem passar por
`keys.js` nem por `operationalTable.js` (fura o ADR-004). Itens de usuário não têm
`ttl` nem `trace_id` (logo são invisíveis ao GSI `trace-index` e ao
`listIncidents` — o que está correto). Porém `scripts/reset.js` faz `Scan` +
`DeleteItem` de **toda** a `monitoracao-operacional`, então `npm run reset` apaga
as contas registradas junto com os incidentes. Além disso, o fallback em memória
de `createUser` devolve "sucesso" para uma escrita que nunca chegou ao DynamoDB.

### H — `dashboard/summary`: os números têm semântica frouxa  · impacto MÉDIO

- `affected-sessions.value` = **soma de `incident.devices`** (contagem de
  dispositivos no seed), rotulada como "Sessões afetadas". O gap-analysis §6 é
  explícito: *"A soma de devices não pode ser chamada de sessões."*
- `active-incidents` = `status !== "success"`; `critical-incidents` =
  `status === "critical"`. Depende do enum de apresentação do seed
  (`critical | warning | info | success`), divergente do enum do contrato
  (`detected | investigating | confirmed | resolved | closed`).

### I — As respostas expõem campos físicos de persistência  · impacto MÉDIO (já documentado)

Todas as rotas de `incidents` / `golden-set` devolvem o **item cru** do DynamoDB:
`pk`, `sk`, `trace_id`, `ttl` vazam na API. O contrato §4.3 / §12: *"pk, sk, GSI,
TTL e outros campos internos nunca aparecem na API pública."* Não há camada de
serialização/DTO.

### J — Aliases de `window` incompletos  · impacto BAIXO

`WINDOW_ALIASES` tem só `15m`, `30m`, `1h`, `24h`. `window=6h` → `Number("6h")` =
`NaN` → default `360` (que por acaso é 6 h — "funciona por acidente"). `window=45m`
→ `NaN` → `360` (não 45). Só número puro (`window=45`) é interpretado como minutos.

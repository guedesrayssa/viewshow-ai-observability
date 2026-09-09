# Mapeamento de endpoints do backend × DynamoDB

> **Snapshot histórico:** este levantamento registra a implementação JavaScript
> observada nos commits indicados abaixo. Ele não descreve o runtime TypeScript
> atual nem o contrato federado vigente; consulte `apps/backend/api/README.md` e
> `apps/fullstack/documentation/infraestrutura-integracao.md` para o estado
> corrente.

O objetivo deste registro era confirmar as leituras e documentar a arquitetura
de dados daquele recorte de código, sem reinterpretá-la a partir dos contratos
alvo.

- **Escopo:** `apps/backend/api/src` no branch `develop` (commit `a06f8f3`).
- **Data do levantamento:** 2026-09-03 (primeira leitura sobre `899691c`);
  **revisado em 2026-09-07** para o `develop` atual (`a06f8f3`).
- **Método:** leitura de `src/app.js`, `src/routes/*.js`, `src/services/*.js`,
  `src/db/*.js`, `src/middleware/requireAuth.js`, `src/auth/session.js`,
  `src/orchestrator/index.js`, `src/agent/index.js`, `scripts/seed.js`,
  `scripts/reset.js` e `apps/fullstack/dynamodb.tf` (definição executável das tabelas).
- **Não houve alteração de código.** Este é um documento de levantamento.

> **Mudança de schema entre `899691c` e `a06f8f3`.** Depois da primeira leitura, o
> MR *"fix(api): corrige fan-out de chave no DynamoDB"* (mergeado no `develop` em
> 2026-09-07) trocou a convenção de `sk` de evidência e hipótese: elas deixaram de
> usar o prefixo `INCIDENT#<id>#…` e passaram a ter prefixo próprio
> (`EVIDENCE#…` / `HYPOTHESIS#…`), com `itemTypeFromSk` lendo os dois esquemas
> durante a transição. Este documento descreve o schema **v2** (`a06f8f3`); o
> antigo aparece marcado como **v1 (legado)** onde ainda é relevante para dados
> não migrados. Ver §1.2 e §4, item **L**.

> Referências de contrato-alvo (para contraste, não é o que está implementado):
> `artefatos/contratos/dashboard-api-contract.md` e
> `artefatos/contratos/dashboard-api-gap-analysis.md`.

---

## 1. Arquitetura de dados no snapshot

### 1.1 Tabelas

| Tabela | Env var | Chave primária | GSI | TTL |
|---|---|---|---|---|
| `monitoracao-operacional` | `OPERATIONAL_TABLE_NAME` | `pk` (S, HASH) + `sk` (S, RANGE) | `trace-index`: HASH `trace_id` (S), RANGE `sk` (S), projeção **ALL** | atributo `ttl` (epoch s), habilitado |
| `monitoracao-golden-set` | `GOLDEN_SET_TABLE_NAME` | `case_id` (S, HASH) — **sem sort key** | nenhum | nenhum |

Fonte do esquema: `apps/fullstack/dynamodb.tf` (as tabelas foram criadas à mão no
console na Sprint 2; o Terraform é a primeira definição executável, derivada do
código que lê/escreve).

### 1.2 Famílias de item em `monitoracao-operacional`

Convenção de chaves centralizada em **`src/db/keys.js`** (só cobre incidente /
evidência / hipótese):

| Família | `pk` | `sk` | `trace_id` | `ttl` | Outros atributos |
|---|---|---|---|---|---|
| **Incidente** | `INC#<YYYY-MM-DDTHH>` (hora UTC do início) | `INCIDENT#<id>` | `<id>` | sim | `id, urgency, title, segment, devices, startedAt, startedMinutesAgo, component, deviceType, region, appVersion, sessions, timeAgo, status, statusLabel` (seed) |
| **Evidência** | mesmo bucket do incidente | `EVIDENCE#<id>#<seq:3>` (v2) — legado v1: `INCIDENT#<id>#EVIDENCE#<seq:3>` | `<id>` | sim | `incidentId, type, description, source, strength, capturedAt` |
| **Hipótese** | mesmo bucket do incidente | `HYPOTHESIS#<id>#<seq:10>` (v2) — legado v1: `INCIDENT#<id>#HYPOTHESIS#<seq:10>` | `<id>` | sim | `incidentId, text, score, source` (seed) / `diagnosisSource` (orquestrador), `createdAt`; após revisão: `reviewStatus, reviewedBy, reviewedAt` |
| **Usuário** *(fora de `keys.js`)* | `USER#<email-normalizado>` | `PROFILE` | — | **não** | `email, name, passwordHash` (`<salt>:<scrypt-hex>`), `createdAt` |

`keys.js` fornece:

- `hourBucket(date)` → `INC#` + `date.toISOString().slice(0,13)` (ex.: `INC#2026-09-03T14`).
- `incidentSk(id)` → `INCIDENT#<id>`.
- `evidenceSk(id, seq)` → `EVIDENCE#<id>#<seq>` com `seq` preenchido a 3 dígitos
  (v2; antes de `a06f8f3` era `INCIDENT#<id>#EVIDENCE#<seq>`).
- `hypothesisSk(id, seq)` → `HYPOTHESIS#<id>#<seq>` com `seq` preenchido a 10 dígitos
  (v2; antes de `a06f8f3` era `INCIDENT#<id>#HYPOTHESIS#<seq>`).
- `itemTypeFromSk(sk)` → `split("#")` e classifica os **dois esquemas**:
  - **v2:** `parts[0] === "EVIDENCE"` e `length >= 3` ⇒ `EVIDENCE`;
    `parts[0] === "HYPOTHESIS"` e `length >= 3` ⇒ `HYPOTHESIS`;
  - **v1 (legado):** `parts[0] === "INCIDENT"` com `length === 2` ⇒ `INCIDENT`;
    `parts[2] === "EVIDENCE"` e `length >= 4` ⇒ `EVIDENCE`;
    `parts[2] === "HYPOTHESIS"` e `length >= 4` ⇒ `HYPOTHESIS`;
  - senão ⇒ `UNKNOWN`.
- `itemTypeFromSk` olha o `sk` inteiro (não só o primeiro segmento) justamente para
  não confundir um filho v1 (`INCIDENT#<id>#EVIDENCE#…`) com um incidente.

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
  registrada; para o usuário fixo de demonstração é `null`. **`maxAge` 8 h é só a
  validade que o navegador aplica ao descartar o cookie** — o valor assinado
  contém somente o e-mail (ver §4, item **M**); o servidor não confere emissão
  nem expiração ao verificar a sessão.
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
  4. `flat()` + `filter(itemTypeFromSk(sk) === "INCIDENT")` + `matchesFilters` + `sort`.
     No schema v2 o `begins_with(sk, "INCIDENT#")` já **não casa** com evidência
     (`EVIDENCE#…`) nem hipótese (`HYPOTHESIS#…`) — o `Query` volta só com
     incidentes. O `filter(itemTypeFromSk === "INCIDENT")` continua ali como
     guarda de compatibilidade para filhos **v1 legados** (`INCIDENT#<id>#EVIDENCE#…`)
     que ainda existam na tabela.
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
- **Response 200:** `{ "evidence": [ { "pk": "…", "sk": "EVIDENCE#<id>#001",
  "trace_id": "<id>", "ttl": …, "incidentId": "<id>", "type": "log",
  "description": "…", "source": "Player", "strength": "forte",
  "capturedAt": "<ISO>" } ] }` — itens **crus**, filtrados por
  `itemTypeFromSk === "EVIDENCE"` (que também reconhece o `sk` v1
  `INCIDENT#<id>#EVIDENCE#001` de itens legados).
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
  - do seed: `{ pk, sk: "HYPOTHESIS#<id>#0000000001", trace_id, ttl, incidentId, text, score, source: "seed", createdAt }` (v1 legado: `INCIDENT#<id>#HYPOTHESIS#0000000001`);
  - do orquestrador: `{ …, text, score, diagnosisSource: "golden-set"|"agent", createdAt }`;
  - após revisão: acrescenta `reviewStatus`, `reviewedBy`, `reviewedAt`.
  "Mais recente" = `getLatestHypothesis` compara **só o último segmento do `sk`**
  (`sk.split("#").at(-1)`, o `seq`/epoch) entre os itens `HYPOTHESIS`, para que
  itens v1 (`INCIDENT#<id>#HYPOTHESIS#<epoch>`) e v2 (`HYPOTHESIS#<id>#<epoch>`)
  coexistam sem o prefixo do schema decidir incorretamente qual é a última.
- **Erros:**
  | HTTP | Corpo | Quando |
  |---|---|---|
  | 404 | `{ error: { message: "Nenhuma hipótese registrada para este incidente" } }` | `bundle.hypotheses` vazio |
  | 500 | `{ error: { message: "Falha ao buscar hipótese" } }` | exceção no `Query` |
- **Leitura no banco:** `getLatestHypothesis` → `getIncidentBundle` → **`Query`**
  GSI `trace-index` por `trace_id`.
- **Escrita:** nenhuma.
- **`keys.js`:** `itemTypeFromSk`; a ordenação assume `hypothesisSk` com largura
  fixa (10 dígitos) no `seq`/epoch para que a comparação do último segmento seja
  cronológica. Ressalva **E** em §4.
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
  `Item = { pk: incident.pk, sk: "HYPOTHESIS#<id>#<epoch:10>", trace_id: <id>, ttl: incident.ttl, incidentId: <id>, text: <hipótese>, score: <número>, diagnosisSource: "golden-set"|"agent", createdAt: <ISO> }` (schema v2; antes de `a06f8f3` gravava `INCIDENT#<id>#HYPOTHESIS#<epoch:10>`).
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
      { "id": "affected-sessions",  "label": "Sessões afetadas",   "value": "<Σ incident.devices, pt-BR>",  "accent": "info" },
      { "id": "active-incidents",   "label": "Incidentes ativos",  "value": "<nº de status !== \"success\">", "accent": "warning" },
      { "id": "critical-incidents", "label": "Incidentes críticos","value": "<nº de status === \"critical\">","accent": "critical" }
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
  No schema v2 esse `begins_with` casa só com incidentes (evidência/hipótese têm
  prefixo próprio) — ver §4, item **L**.
- **Escrita:** nenhuma.
- **`keys.js`:** `hourBucket`, `itemTypeFromSk`. Padrão **bate**. Ressalvas **A**, **H** em §4.
- **Auth:** não.

---

## 4. Aderência a `src/db/keys.js` e inconsistências encontradas

Resumo por rota:

| Rota | Padrão de leitura bate com `keys.js`? | Ressalvas |
|---|---|---|
| `GET /health`, `GET /auth/sso`, `POST /ml/analyze` | n/a (não tocam banco) | — |
| `POST /auth/login`, `POST /auth/register` | **Fora de `keys.js`** — família `USER#`/`PROFILE` montada em `userService.js` | **G**, **M** (só `/login`) |
| `GET /api/v1/incidents` | Sim (`pk = INC#<hora>`, `sk` por `begins_with("INCIDENT#")`) | **A**, **B**, **C**, **I**, **J**, **K**, **L** (corrigido em `a06f8f3`; resíduo só p/ dados v1) |
| `GET /api/v1/incidents/:id` `/evidence` `/hypothesis` | Sim (GSI `trace-index`, `itemTypeFromSk`) | **C**, **E** (só `/hypothesis`), **I**, **K** |
| `PATCH …/hypothesis/review` | Parcial — leitura via `keys.js`; chave do golden set fora de `keys.js` | **C**, **D**, **E** |
| `POST …/diagnose` | Sim (`hypothesisSk`, GSI `trace-index`, `GetItem` golden set por assinatura) | **C**, **E**, **F** |
| `GET /api/v1/golden-set` | n/a para `keys.js`; usa `case_id` = assinatura (`dynamodb.tf`) | — |
| `GET /api/v1/dashboard/summary` | Sim | **A**, **C**, **H**, **I**, **K**, **L** (corrigido em `a06f8f3`; resíduo só p/ dados v1) |

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
npm run seed` "conserta" temporariamente — o que confirma o diagnóstico. (Esse
"conserta" pressupõe que o `reset` limpou a tabela inteira; acima de 1 MB isso
não é garantido — ver item **K**, `Scan` sem paginação.)

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

### C — `itemTypeFromSk` pressupõe `id` de incidente sem `#` (fragilidade latente)  · impacto MÉDIO

`itemTypeFromSk` faz `sk.split("#")` e, para o **incidente**, decide por
`parts[0] === "INCIDENT"` e `parts.length === 2`. Isso só funciona enquanto o `id`
do incidente for **um único segmento sem `#`**. Os `id`s do seed são slugs
(`falhas-reproducao-tvs-lg`), então hoje está ok.

Se um `id` algum dia contiver `#` (ou vier o "id canônico opaco" previsto no
contrato-alvo), o `sk` de incidente `INCIDENT#a#b` passa a ter `parts.length === 3`
sem `parts[2]` em `{EVIDENCE, HYPOTHESIS}` → cai no `return "UNKNOWN"` final → o
incidente **desaparece** de toda listagem (`listIncidents` filtra `=== "INCIDENT"`)
e de todo bundle. O comentário em `keys.js` documenta a convenção, mas o código não
a defende.

**No schema v2 o risco é menor para evidência/hipótese:** elas passam a ser
classificadas por `parts[0] === "EVIDENCE"`/`"HYPOTHESIS"` com `length >= 3`, então
um `#` no `id` não as derruba para `UNKNOWN`. O ramo frágil que resta é o do
**incidente** (`INCIDENT#<id>` com `id` de segmento único) e o dos filhos **v1
legados** (`INCIDENT#<id>#EVIDENCE#…`), que continuam dependendo de `parts[2]`.

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

### G — Contas de usuário fora da convenção de `keys.js`  · impacto BAIXO

`userService` monta `pk = USER#<email>`, `sk = "PROFILE"` direto, sem passar por
`keys.js` nem por `operationalTable.js` (fura o ADR-004). Itens de usuário não têm
`ttl` nem `trace_id` (logo são invisíveis ao GSI `trace-index` e ao
`listIncidents` — o que está correto).

`scripts/reset.js` faz `Scan` + `DeleteItem` em `monitoracao-operacional`, mas
desde o hotfix `899691c` ("script reset não mais apaga conta de usuário") o
`Scan` é seguido de um filtro explícito — só é apagado o item cujo `pk` começa
com `DELETABLE_PK_PREFIX = "INC#"`. Contas de usuário (`pk = USER#<email>`) ficam
de fora; `npm run reset` hoje **não** apaga contas registradas. (Versões
anteriores deste levantamento, feitas sobre a branch de feature antes do rebase
para `develop`, afirmavam o contrário — corrigido aqui.) Esse `Scan` é de página
única — sem laço de `LastEvaluatedKey` —, então acima de 1 MB o reset é parcial
(ver item **K**).

Além disso, o fallback em memória de `createUser` devolve "sucesso" para uma
escrita que nunca chegou ao DynamoDB.

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

### K — Nenhuma `Query` é paginada; `LastEvaluatedKey` é descartado  · impacto ALTO

`operationalTable.query()` (`src/db/operationalTable.js`) e `goldenSetTable.query()`
fazem `documentClient.send(new QueryCommand(...))` e devolvem só `result.Items || []`
— `result.LastEvaluatedKey` nunca é lido nem propagado. Uma `Query` do DynamoDB
processa no máximo **1 MB de dados por chamada** e sinaliza mais páginas via
`LastEvaluatedKey`; sem um laço que reenvie `ExclusiveStartKey`, qualquer resultado
que ultrapasse esse teto é **truncado silenciosamente**, sem erro e sem indicação
no corpo da resposta ([documentação oficial da AWS sobre paginação de `Query`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.html#Query.Pagination)).

Isso atinge todo caminho que usa `Query` na tabela base:

- `listIncidents` (rotas 5 e 13): cada bucket de hora (`Query` por
  `pk = "INC#<hora>"`) para de devolver itens além de 1 MB acumulado naquele
  bucket — incidentes reais seriam omitidos da listagem sem qualquer sinal de
  que a página não é a única. No schema v2 a `Query` não carrega mais
  evidência/hipótese junto (item **L**), então o teto é gasto só com incidentes;
  em um ambiente com resíduo v1, os filhos legados ainda contam para o 1 MB.
- `getIncidentBundle` (rotas 6, 7, 8; GSI `trace-index`): um incidente com
  evidências/hipóteses suficientes para passar de 1 MB perde silenciosamente o
  restante do bundle.
- `dashboard/summary` (rota 13): mesmo truncamento de `listIncidents`, refletido
  nos contadores e em `recentIncidents`.

**O mesmo vale para `scripts/reset.js`.** Ele faz um único `ScanCommand`
(`ProjectionExpression: "pk, sk"`) e itera `scan.Items` — `scan.LastEvaluatedKey`
nunca é lido. Um `Scan` também para em 1 MB por página; numa tabela acima disso,
`npm run reset` apaga só a primeira página de itens `INC#` e **deixa incidentes
antigos para trás**. Ou seja, `npm run reset && npm run seed` não garante um
ambiente limpo quando a tabela passa de 1 MB — o que enfraquece o "rodar
`reset && seed` conserta" citado no item **A**.

Com o volume atual do seed (300 incidentes, 2.341 registros) o teto de 1 MB
provavelmente não é atingido em nenhuma chamada isolada — por isso o sintoma não
aparece hoje. Mas o levantamento descreve **como a API opera**, e a ausência de
paginação é uma propriedade do código, não do volume de teste: ela se torna um
bug de dados incompletos (ou de reset incompleto) assim que a base crescer, sem
exigir nenhuma mudança de código para se manifestar.

### L — Amplificação de leitura por prefixo `INCIDENT#` compartilhado  · **corrigido em `a06f8f3`** (era impacto ALTO)

**Estado v1 (até `899691c`).** Evidência e hipótese usavam `sk` prefixado por
`INCIDENT#<id>#…`, igual ao incidente. A `Query` de `listIncidents`
(`begins_with(sk, "INCIDENT#")`) casava com os três tipos sob o mesmo `pk`, e o
recorte para só incidentes acontecia depois, em memória
(`flat()` + `filter(itemTypeFromSk(sk) === "INCIDENT")`). O DynamoDB não tinha
como filtrar do lado do servidor.

`artefatos/sprint2/testes-desempenho.md` (§8.1–8.2) mediu esse caminho sob carga
**sobre o schema v1**: 2.341 registros lidos e transferidos para devolver 291
incidentes (**~87% do trabalho de leitura descartado em memória**), 967 RCU/s,
~8× o custo de uma chave que separasse os prefixos. **Esse número é um resultado
histórico do schema v1**, não uma medição do código atual.

**Estado v2 (`a06f8f3`, MR *"fix(api): corrige fan-out de chave no DynamoDB"*).**
`evidenceSk`/`hypothesisSk` passaram a usar prefixo próprio
(`EVIDENCE#…` / `HYPOTHESIS#…`). Agora:

- `listIncidents` continua com `begins_with(sk, "INCIDENT#")`, mas isso **casa só
  com incidentes** — a `Query` já não traz evidência/hipótese, então o filtro em
  memória virou uma guarda de compatibilidade (ver abaixo), não a linha de
  defesa principal.
- `itemTypeFromSk` classifica os dois esquemas (v1 e v2), para que itens
  gravados antes da migração continuem legíveis.
- `getLatestHypothesis` compara só o último segmento do `sk` (o `seq`/epoch),
  para ordenar corretamente hipóteses v1 e v2 misturadas.

**Ressalva residual — dados legados.** Itens v1 já gravados
(`INCIDENT#<id>#EVIDENCE#…` / `…#HYPOTHESIS#…`) **ainda começam por `INCIDENT#`** e
continuam sendo lidos e descartados em memória pela `Query` de `listIncidents`
até que a tabela seja migrada ou recriada (`npm run reset && npm run seed`, que
regrava tudo no schema v2). Em um ambiente só com dados v2 a amplificação não
existe; em um ambiente com resíduo v1, ela persiste proporcionalmente ao volume
legado.

**Pendência.** Não há ainda uma medição de desempenho na AWS sobre o schema v2
equivalente à de sprint2 — a redução de RCU/s e do trabalho descartado está
prevista pelo desenho da chave, mas **ainda não foi medida**.

### M — Cookie de sessão não tem expiração aplicada pelo servidor  · impacto MÉDIO

`signSession` (`src/auth/session.js`) assina só o payload `base64url(email)` com
HMAC-SHA256; não há `iat` (instante de emissão) nem `exp` (expiração) no valor
assinado. `verifySession` (mesmo arquivo) faz apenas
`crypto.timingSafeEqual` entre a assinatura recebida e a esperada — não decodifica
nem confere nenhum campo de tempo, porque não existe campo de tempo para conferir.

O `maxAge: 8h` do `Set-Cookie` (rota `POST /auth/login`, §2) é uma instrução para
o **navegador** descartar o cookie após 8 h — não uma validade que o backend
impõe. Um valor de cookie copiado antes desse descarte (log, proxy, dispositivo
comprometido) continua sendo aceito por `requireAuth` **indefinidamente**, em
qualquer horário, até que `AUTH_COOKIE_SECRET` seja trocado. Não há revogação de
sessão nem lista de invalidação — trocar a senha do usuário, por exemplo, não
invalida cookies já emitidos, já que o valor assinado nem contém a senha.

O levantamento deve distinguir as duas coisas: **expiração no navegador**
(existe, 8 h) e **validade criptográfica no backend** (não existe — o cookie é
válido enquanto o segredo não mudar).

---

## 5. Golden Set: existe endpoint que grava uma hipótese avaliada como falsa?

**Não. Não existe.**

### 5.1 Todos os caminhos de escrita em `monitoracao-golden-set`

| Camada | O que é |
|---|---|
| `src/db/goldenSetTable.js` | Única porta de baixo nível. Exporta `get`, `query`, **`putCurated`** — e **de propósito não exporta** `put`/`update`/`delete` genéricos (barreira estrutural do ADR-002; o cabeçalho do arquivo explica). |
| `src/services/goldenSetService.js` → `promoteCase(incident, hypothesis, curatedBy)` | Único chamador de `putCurated`. |
| `src/routes/incidents.js` → `PATCH /api/v1/incidents/:id/hypothesis/review` | Único chamador de `promoteCase`, **exclusivamente no ramo `if (status === "confirmed")`** (linhas 74-77). |

Não há nenhum outro `require` de `goldenSetTable` nem de `goldenSetService` com
escrita em todo `src/`. `POST /api/v1/ml/analyze` é mock e não toca banco;
`GET /api/v1/golden-set` é só leitura.

### 5.2 O que acontece quando a hipótese é julgada **falsa** (`status: "refuted"`)

`PATCH …/hypothesis/review` com `status = "refuted"`:

1. `evidenceService.reviewHypothesis` faz **só** um `UpdateItem` em
   `monitoracao-operacional` no próprio item da hipótese, gravando
   `reviewStatus: "refuted"`, `reviewedBy: <e-mail da sessão>`, `reviewedAt: <ISO>`.
2. **Nada é escrito em `monitoracao-golden-set`** — o ramo que chama `promoteCase`
   só roda para `"confirmed"`.

Além disso, o item que `promoteCase` grava **não tem campo de veredito**: os
atributos são `case_id`, `incident_signature`, `expected_hypothesis`,
`expected_score`, `curated_by`, `curated_at`, `source_incident_id`. É sempre um
caso "esperado/positivo" — não há `verdict`, `label`, `is_false`,
`refuted_hypothesis` ou equivalente. E a rota nem aceita o `inconclusive` previsto
no contrato (validação só admite `confirmed | refuted`).

### 5.3 Onde essa escrita **deveria** acontecer, se for desejada

O contrato §8 menciona *"A promoção **ou invalidação** no golden set é um efeito
interno e não bloqueia a resposta HTTP."* — mas **não define** o que "invalidação"
significa nem prevê persistência de exemplos negativos. Antes de projetar o
código, é preciso separar três coisas distintas que o termo "invalidação" mistura:

**(a) Invalidar / remover / desativar um caso positivo existente.**
`findMatchingCase(signature)` faz `GetItem` em `monitoracao-golden-set` pela
**chave exata** `case_id = "<component>#<deviceType>#<region>"`. Hoje não há
nenhum caminho que apague, sobrescreva ou marque como inativo um caso já curado.
Uma refutação escrita numa chave **diferente** (ex.: `<assinatura>#REFUTED#<seq>`)
**não invalida** o caso positivo: o `GetItem` pela assinatura pura continua
achando e devolvendo o caso `confirmed` intacto. Invalidar de fato exigiria
`DeleteItem` na chave da assinatura, ou um atributo `active`/`invalidated_at` no
próprio item positivo mais um filtro em `findMatchingCase`.

**(b) Armazenar hipóteses refutadas como exemplos negativos.**
É um modelo de dados **novo**, não coberto pelo contrato. A tabela tem chave
**simples** `case_id`, **sem sort key** (`dynamodb.tf`): um positivo e um negativo
para a mesma assinatura colidiriam no mesmo item. Guardar negativos exige `case_id`
composto (ex.: `<assinatura>#REFUTED#<seqHipótese>`) **ou** uma sort key — ou seja,
alterar `apps/fullstack/dynamodb.tf` e a convenção de chaves. O ideal seria
`src/db/keys.js` passar a conhecer a família de chaves do golden set (hoje não
conhece nada dela).

**(c) Como o orquestrador consultaria cada modelo.**
Hoje o orquestrador só faz uma consulta: `findMatchingCase` → `GetItem` pelo
positivo. Para usar negativos ele precisaria de uma **segunda** leitura — um
`Query` por `begins_with(case_id, "<assinatura>#REFUTED#")` (com chave composta)
ou pela sort key — e de uma regra de precedência definida (um negativo recente
suprime o positivo? apenas rebaixa o score? só serve de contexto para o agente?).
Nada disso está especificado.

**Se, definido o acima, o time quiser o caminho (b)+(c)**, os passos de código são:

1. **`src/db/goldenSetTable.js`** — um segundo método de escrita explícito
   (ex.: `putRefuted`), **ou** aceitar um atributo `verdict` no item de
   `putCurated`. Não reintroduzir um `put` genérico, para manter a barreira do
   ADR-002.
2. **`src/services/goldenSetService.js`** — uma função
   `recordRefutedCase(incident, hypothesis, curatedBy)` e a lógica de consulta de
   (c) em `findMatchingCase` (ou numa função irmã).
3. **`src/routes/incidents.js`** — chamar essa função no ramo `status === "refuted"`
   (hoje inexistente), simétrico ao `promoteCase` do ramo `confirmed`, e decidir o
   comportamento para `inconclusive` se o enum for ampliado.
4. **Mudança de modelo de dados** (chave composta ou sort key em
   `monitoracao-golden-set`), conforme (b).
5. Rever `scripts/reset.js` (`TEST_PROMOTED_CASES`) para também limpar casos
   refutados criados por teste.

---

## 6. Resumo executivo

- **13 rotas.** Só `PATCH /api/v1/incidents/:id/hypothesis/review` exige
  autenticação. Três rotas escrevem (`POST /auth/register`, `PATCH …/review`,
  `POST …/diagnose`); duas delas sem `requireAuth`. O cookie de sessão emitido
  em `POST /auth/login` não carrega expiração própria — `maxAge: 8h` é só a
  validade que o navegador aplica; o backend aceita o mesmo cookie
  indefinidamente até a troca de `AUTH_COOKIE_SECRET` (**M**).
- **Duas tabelas:** `monitoracao-operacional` (single-table: incidentes,
  evidências, hipóteses e — fora de `keys.js` — usuários; GSI `trace-index`
  projeção ALL; TTL) e `monitoracao-golden-set` (chave simples `case_id` =
  assinatura `<component>#<deviceType>#<region>`; sem GSI; sem TTL).
- **Operações usadas:** `Query`, `GetItem`, `PutItem`, `UpdateItem`. Nenhuma rota
  usa `BatchGetItem` ou `TransactWriteItems`; `Scan` só no script `reset.js`
  (e sem paginação — ver **K**).
- **Schema de chave v2 (`a06f8f3`).** Evidência e hipótese usam prefixo próprio
  (`EVIDENCE#<id>#<seq>` / `HYPOTHESIS#<id>#<seq>`); `itemTypeFromSk` ainda lê o
  schema v1 (`INCIDENT#<id>#EVIDENCE|HYPOTHESIS#…`) para dados não migrados, e
  `getLatestHypothesis` compara só o último segmento do `sk` para ordenar v1 e v2
  misturados.
- **Os padrões de `pk`/`sk` das rotas batem com `src/db/keys.js`** — a leitura não
  está "errada" no sentido de montar a chave errada. O defeito estrutural que
  resta é **K**: nenhuma `Query` é paginada. A
  amplificação de leitura por prefixo `INCIDENT#` compartilhado (**L**), medida em
  `artefatos/sprint2/testes-desempenho.md` como ~87% do trabalho descartado / 967
  RCU/s sobre o **schema v1**, foi **corrigida em `a06f8f3`** — resta amplificação
  proporcional só onde ainda houver dados v1 não migrados, e uma **medição na AWS
  sobre o v2 ainda pendente**.
- **A inconsistência que explica "ele não tá lendo de maneira correta" é a A:** a
  janela de consulta é recalculada a partir do relógio real, enquanto o `pk` do
  incidente e o `startedMinutesAgo` foram congelados no `seed`. Horas depois da
  carga, os `Query`s por bucket deixam de cobrir os incidentes e as listagens /
  o resumo esvaziam sozinhos. Complementarmente, a **B**: a janela nunca é
  aplicada ao timestamp do item, só à quantidade de buckets de hora.
- **Golden Set:** não há endpoint que grave hipótese refutada / "falsa". O único
  gatilho de escrita é `promoteCase`, e só para `status === "confirmed"`. O
  contrato fala em "promoção ou invalidação" mas não define o que invalidar
  significa nem prevê exemplos negativos — §5.3 separa (a) invalidar um caso
  positivo, (b) persistir refutações como exemplos negativos e (c) como o
  orquestrador consultaria cada um. Habilitar (b)+(c) exige código **e** mudança
  de modelo de dados (chave composta ou sort key na tabela do golden set).

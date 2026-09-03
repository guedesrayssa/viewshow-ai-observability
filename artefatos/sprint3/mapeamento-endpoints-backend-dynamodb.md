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

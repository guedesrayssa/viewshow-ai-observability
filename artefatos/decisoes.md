## IAM — Fase 2

Testado `iam:CreateRole` na conta do laboratório: retornou `AccessDenied`.
Só é possível usar `LabRole` (execution role e, por consequência, task role
de tudo que rodar nesta conta). Não há separação de IAM real entre o job de
ingestão e a API.

**Consequência para o ADR-002**: a proteção de escrita da tabela
`monitoracao-golden-set` não é imposta por IAM — é imposta por código.
`services/goldenSetService.js` é o único módulo autorizado a instanciar um
client para essa tabela, e esse módulo nunca importa `PutItemCommand`/
`UpdateItemCommand`. Revisão de código substitui a política IAM como
mecanismo de proteção. Risco aceito do ambiente AWS Academy.

## Convenção de chaves — monitoracao-operacional

- pk: `INC#<hora-UTC-ISO>` (bucket de hora)
- sk: `INCIDENT#<id>` | `INCIDENT#<id>#EVIDENCE#<seq:3>` | `INCIDENT#<id>#HYPOTHESIS#<epoch:10>`
- trace_id: `<incident_id>` em todo item (alimenta o GSI trace-index)
- ttl: epoch seconds
- golden-set: `case_id` é a própria assinatura determinística `<component>#<deviceType>#<region>`
  (permite `GetItem` direto, sem Scan e sem GSI extra)

## Estrutura da API (apps/backend/api/src)

- `db/` — client DynamoDB único + `operationalTable.js` (Query/Put/Update) e
  `goldenSetTable.js` (só Query/Get — não exporta escrita, é a proteção do
  ADR-002 aplicada em código).
- `services/evidenceService.js` — única porta para incidentes/evidências/
  hipóteses (ADR-004). `services/goldenSetService.js` — única porta para
  golden set. `services/mlService.js` — ML mockado (contrato fixo, regra 6
  do plano). `services/bedrockService.js` — explicação em linguagem natural,
  com fallback por template quando `BEDROCK_ENABLED != "true"` ou a chamada
  falha.
- `orchestrator/` — decide golden-set (determinístico) vs. agente (ambíguo).
- `agent/` — investiga chamando `mlService` como ferramenta; nunca acessa o
  banco direto.
- `routes/` — `health`, `auth` (login fixo por env var + cookie assinado,
  SSO como stub 501), `incidents` (list/detail/evidence/diagnose), `golden-set`
  (lookup por assinatura), `ml`, `dashboard` (resumo derivado dos incidentes).

`GET /api/v1/dashboard/summary` **não** replica as métricas "taxa de erros"/
"latência p95" do mock original do frontend — isso é telemetria bruta que
viria do job de ingestão (fora de escopo desta fase). Só expõe o que dá pra
derivar de incidentes já registrados (sessões afetadas, contagem de
incidentes ativos/críticos).

## Infraestrutura da API (Dia 9)

A Pessoa A só tinha montado infraestrutura para o **job de ingestão**
(`data-ingestion-cluster`/`-service`/`-alb`/ECR `data-ingestion-service`) —
nada para a API. Criado nesta fase, tudo aditivo, sem alterar o que já
existia:

- ECR: `monitoracao-api` (imagem publicada como `:v1`)
- Task Definition: `monitoracao-api-task` (`LabRole` como execution e task
  role — única opção neste ambiente; variáveis de ambiente com as tabelas,
  flags e credenciais de demo do auth mínimo)
- Security Group dedicado `monitoracao-api-sg`: só libera porta 3000 a
  partir do SG do ALB (`sg-02b27fde4fc636ee2`) — o SG existente do job não
  foi alterado
- Target Group `monitoracao-api-tg` (porta 3000, health check `/health`)
- Regra nova no listener do `data-ingestion-alb` (prioridade 10, path
  `/api/*`, `/auth/*`, `/health` → `monitoracao-api-tg`) — a ação padrão do
  listener, que serve o job, não foi tocada
- Service `monitoracao-api-service` no cluster `data-ingestion-cluster`
  (mesmo cluster, serviço novo — o `data-ingestion-service` não foi mexido)

Testado publicamente pelo DNS do ALB (`/health`, `/api/v1/incidents`) e
confirmado que a rota do job (`/incomes`) continua respondendo normalmente.

## Plano de teste de integridade da API

Checklist pra rodar sempre que mexer em `apps/backend/api` — cobre as duas
tabelas, as três camadas (services/orchestrator/agent) e as rotas HTTP de
ponta a ponta. Serve de base pra virar teste automatizado depois; por
enquanto é manual, via `curl`, contra o DynamoDB real (não usa mock).

### Pré-requisito: baseline limpo

Os testes de contagem (13, 14, 15) só fazem sentido a partir de um estado
conhecido. Resetar a tabela operacional e re-semear antes de rodar tudo:

```bash
cd apps/backend/api
node -e "
require('dotenv').config({ quiet: true });
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
(async () => {
  const scan = await client.send(new ScanCommand({ TableName: 'monitoracao-operacional', ProjectionExpression: 'pk, sk' }));
  for (const item of scan.Items) await client.send(new DeleteCommand({ TableName: 'monitoracao-operacional', Key: { pk: item.pk, sk: item.sk } }));
  console.log('Removidos', scan.Items.length);
})();
"
npm run seed
```

Depois do seed: `monitoracao-operacional` deve ter **11 itens** (4
incidentes + 5 evidências + 2 hipóteses) e `monitoracao-golden-set` deve
ter **3 itens**. Subir a API localmente com `npm start` antes do passo 1.

### Casos de teste

| # | Teste | Comando | Resultado esperado |
|---|---|---|---|
| 1 | Health check | `curl http://localhost:3000/health` | `200`, `{"status":"ok"}` |
| 2 | Listar incidentes | `curl http://localhost:3000/api/v1/incidents` | 4 incidentes (os 4 semeados) |
| 3 | Detalhe de incidente | `curl http://localhost:3000/api/v1/incidents/falhas-reproducao-tvs-lg` | campos corretos (`urgency: "P1"`, `component: "Player"`) |
| 4 | Evidências do incidente | `curl http://localhost:3000/api/v1/incidents/falhas-reproducao-tvs-lg/evidence` | 2 evidências |
| 5 | Incidente inexistente | `curl http://localhost:3000/api/v1/incidents/nao-existe` | `404` |
| 6 | Golden set — assinatura existente | `curl -G .../api/v1/golden-set --data-urlencode "signature=Player#Smart TV#Nordeste"` | `expected_score: 0.85` |
| 7 | Golden set — sem assinatura | `curl .../api/v1/golden-set` | `400` |
| 8 | ML mockado | `curl -X POST .../api/v1/ml/analyze -d '{"a":1}'` | contrato fixo (`model: "mock-v0"`), ecoa as chaves recebidas |
| 9 | Login — credenciais corretas | `curl -X POST .../auth/login -d '{"email":"demo@globoplay.com","password":"demo123"}'` | `200` + `Set-Cookie` |
| 10 | Login — credenciais erradas | `curl -X POST .../auth/login -d '{"email":"x","password":"y"}'` | `401` |
| 11 | Diagnóstico — bate com golden set | `curl -X POST .../api/v1/incidents/falhas-reproducao-tvs-lg/diagnose` | `source: "golden-set"`, `score: 0.85` |
| 12 | Diagnóstico — sem match, cai no agente | `curl -X POST .../api/v1/incidents/tokens-autenticacao-invalidos/diagnose` | `source: "agent"`, `score: 0.6` (do ML mock) |
| 13 | Diagnóstico — incidente inexistente | `curl -X POST .../api/v1/incidents/nao-existe/diagnose` | `404` |
| 14 | Resumo do dashboard | `curl .../api/v1/dashboard/summary` | `stats` agregados batem com os 4 incidentes (ex.: `affected-sessions: "11.784"`) |
| 15 | Contagem final da operacional | `aws dynamodb scan --table-name monitoracao-operacional --select COUNT` | 11 (base) + 1 por cada `diagnose` chamado nos testes 11/12 = **13** |
| 16 | Golden set permanece intocada | `aws dynamodb scan --table-name monitoracao-golden-set --select COUNT` | **3, sem alteração** — é a confirmação prática de que nenhum caminho de código escreve nessa tabela (ver seção IAM acima) |

O teste 16 é o mais importante do conjunto: mesmo depois de rodar os dois
fluxos de diagnóstico (11 e 12), a golden set precisa continuar com a
mesma contagem de antes. Se esse número mudar, a proteção por código
quebrou e precisa ser investigada antes de qualquer outra coisa.

### Última execução

2026-08-25 — 16/16 testes passaram, contagens finais exatas (13 na
operacional, 3 na golden set, inalterada).
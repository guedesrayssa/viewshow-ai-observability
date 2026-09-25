# Documentação Técnica: Backend — Sprint 2 (DynamoDB → API → Camada Agêntica)

> Este documento descreve a implementação técnica da segunda etapa do backend do sistema de Monitoração Agêntica do Globoplay, cobrindo tudo **a partir do DynamoDB**: a modelagem das duas tabelas, a API em camadas (Fargate), o esqueleto simplificado da camada agêntica, a infraestrutura AWS provisionada para publicá-la e o roteiro de testes de integridade executado. A etapa anterior (ARGUS → BigQuery → job de consumo/processamento → DynamoDB) é tratada em documentação própria e não é repetida aqui. As decisões de arquitetura completas (ADRs) estão em [`arquitetura-inicial.md`](arquitetura-inicial.md).

**Grupo:** G05 · **Parceiro:** Grupo Globo (Globoplay) — Projeto (CCMD7) · **Sprint:** 2

> **Vídeo de Demonstração:** [Assista à demonstração técnica no YouTube](https://youtu.be/y7UuCoxtTZU)

## Sumário

1. [Visão geral e contexto do sprint](#1-visão-geral-e-contexto-do-sprint)
2. [Modelagem de dados (DynamoDB)](#2-modelagem-de-dados-dynamodb)
3. [Estrutura da API em camadas](#3-estrutura-da-api-em-camadas)
4. [Camada agêntica](#4-camada-agêntica)
5. [Autenticação e controle de acesso](#5-autenticação-e-controle-de-acesso)
6. [Contrato de rotas da API](#6-contrato-de-rotas-da-api)
7. [Infraestrutura AWS provisionada](#7-infraestrutura-aws-provisionada)
8. [Decisões técnicas e riscos aceitos](#8-decisões-técnicas-e-riscos-aceitos)
9. [Plano e execução de testes de integridade](#9-plano-e-execução-de-testes-de-integridade)
10. [Referências](#10-referências)

---

## 1. Visão geral e contexto do sprint

&emsp; Ao início deste sprint, a infraestrutura AWS já existia apenas para o **job de ingestão** (BigQuery → DynamoDB): cluster ECS, ALB e repositório ECR próprios, todos com prefixo `data-ingestion-*`. O código da API tinha só um esqueleto Express com duas rotas mockadas (`GET /health`, `GET /items` com dados fictícios), sem nenhuma integração real com DynamoDB, Docker ou deploy. Este sprint cobriu integralmente o trecho `DynamoDB → API (com camada agêntica) → Dashboard` da arquitetura do MVP (ver [`arquitetura-inicial.md`](arquitetura-inicial.md), Seção 1), partindo desse esqueleto até uma API publicada, testada e consumível pelo frontend.

&emsp; O trabalho seguiu a ordem: (1) modelagem das duas tabelas DynamoDB e da política de acesso a cada uma; (2) reestruturação da API em camadas; (3) implementação incremental de cada camada (serviço de evidências, serviço de golden set, orquestrador, agente, extensão do Bedrock, módulo de ML mockado, autenticação mínima); (4) provisionamento da infraestrutura AWS da API a partir do zero; (5) validação de ponta a ponta via um roteiro de testes de integridade reexecutável; (6) extensão das rotas para suportar a tela de Evidências, incluindo o fluxo de confirmação/refutação de hipótese pelo especialista.

&emsp; A integração do `apps/frontend` com essas rotas — troca dos dados mockados pelas chamadas reais — é tratada na documentação própria do frontend, não neste documento.

---

## 2. Modelagem de dados (DynamoDB)

&emsp; Seguindo o ADR-002 (ver [`arquitetura-inicial.md`](arquitetura-inicial.md)), os dados vivem em **duas tabelas separadas**, cada uma com um papel e um perfil de escrita diferente.

<div align="center">

<sup>Tabela 1: Tabelas DynamoDB da Fase 2</sup>

| Tabela | Papel | Quem escreve |
|:---|:---|:---|
| `monitoracao-operacional` | Incidentes, evidências e hipóteses — reescrita a cada ciclo de diagnóstico | API (via `evidenceService`); o job de ingestão escreveria os incidentes/evidências brutos aqui (fora do escopo deste sprint) |
| `monitoracao-golden-set` | Casos curados manualmente — régua de qualidade do diagnóstico (RNF08) | Só a API, e só através de um caminho único e deliberado (Seção 4.3) |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 2.1. Convenção de chaves — `monitoracao-operacional`

&emsp; O desenho reaproveita o padrão já usado na tabela `telemetry` do MVP básico: `pk` por bucket de tempo, `sk` de largura fixa por tipo de item, e um índice global secundário (GSI) esparso por `trace_id` para buscar tudo sobre um incidente sem depender do bucket de tempo.

<div align="center">

<sup>Tabela 2: Esquema de chaves de `monitoracao-operacional`</sup>

| Campo | Formato | Papel |
|:---|:---|:---|
| `pk` | `INC#<hora-UTC-ISO>` | Bucket de hora — permite `Query` por janela de tempo sem `Scan` |
| `sk` | `INCIDENT#<id>` \| `EVIDENCE#<id>#<seq:3>` \| `HYPOTHESIS#<id>#<epoch:10>` | Prefixo discriminante por tipo; `trace_id` mantém os itens do incidente agrupados no GSI |
| `trace_id` | `<incident_id>` | Presente em todo item do incidente; alimenta o GSI `trace-index` |
| `ttl` | epoch seconds | TTL nativo do DynamoDB |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; O GSI `trace-index` (`trace_id` como chave de partição, `sk` como chave de ordenação) é o que permite buscar incidente + evidências + hipóteses com um único `Query`, independente de qual bucket de hora o incidente caiu — usado por `getIncidentBundle` (ver Seção 3).

&emsp; O schema v1 usava filhos com `INCIDENT#<id>#EVIDENCE#…` e
`INCIDENT#<id>#HYPOTHESIS#…`, o que fazia `listIncidents` ler também os filhos.
Novas escritas usam os prefixos discriminantes acima; a classificação de leitura
continua aceitando v1 para permitir transição sem esvaziar bundles existentes.

### 2.2. Convenção de chaves — `monitoracao-golden-set`

&emsp; `case_id` é a própria assinatura determinística do incidente (`<component>#<deviceType>#<region>`), o que permite buscar um caso curado com um `GetItem` direto, sem precisar de índice secundário.

<div align="center">

<sup>Tabela 3: Itens de `monitoracao-golden-set`</sup>

| Campo | Descrição |
|:---|:---|
| `case_id` | Assinatura do caso — também a chave de partição |
| `incident_signature` | Mesma assinatura, redundante para leitura |
| `expected_hypothesis` | Hipótese de causa raiz curada |
| `expected_score` | Confiança curada (0–1) |
| `curated_by` | E-mail de quem curou o caso |
| `curated_at` | Timestamp da curadoria |
| `source_incident_id` | Incidente de origem, quando o caso vem de uma promoção via revisão humana (Seção 4.3) |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 2.3. Dados de teste

&emsp; Como a Fase 1 (job de ingestão) não roda neste ambiente, os dados de teste são gerados por [`apps/backend/api/scripts/seed.js`](../../apps/backend/api/scripts/seed.js) (`npm run seed`), idempotente: popula 4 incidentes de exemplo (P1 a P4, cobrindo os mesmos casos usados no protótipo de alta fidelidade do frontend) com evidências classificadas por força (`forte`/`neutra`/`contra`) e hipóteses, além de 3 casos curados na golden set.

---

## 3. Estrutura da API em camadas

&emsp; A API (`apps/backend/api/src`) segue o princípio do ADR-004: cada camada só enxerga a de baixo, nunca pula uma etapa.

```text
routes/  →  orchestrator + agent  →  services/  →  db/  →  DynamoDB
```

<div align="center">

<sup>Tabela 4: Camadas da API</sup>

| Camada | Diretório | Responsabilidade |
|:---|:---|:---|
| Acesso a dados | `src/db/` | `client.js` (client DynamoDB único), `operationalTable.js` (Query/Put/Update), `goldenSetTable.js` (Query/Get livres; escrita restrita — Seção 4.3), `keys.js` (única fonte da convenção de chaves da Seção 2.1) |
| Serviços | `src/services/` | `evidenceService.js` (única porta para a tabela operacional), `goldenSetService.js` (única porta para a golden set), `mlService.js` (módulo de ML mockado), `bedrockService.js` (explicação em linguagem natural, com fallback) |
| Decisão | `src/orchestrator/` | Resolve direto o que é determinístico (caso já existe na golden set) ou delega ao agente |
| Investigação | `src/agent/` | Investiga chamando o `mlService` como ferramenta; nunca acessa o banco diretamente |
| Autenticação | `src/auth/`, `src/middleware/` | `session.js` (assinatura/verificação do cookie), `requireAuth.js` (middleware para rotas protegidas) |
| HTTP | `src/routes/` | Tradução request/response; nenhuma regra de negócio mora aqui |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; Cada `service` é a **única porta** de acesso à sua tabela — nenhum outro módulo importa `db/operationalTable.js` ou `db/goldenSetTable.js` diretamente, o que mantém o dado auditável (ADR-004) e é verificável por inspeção de código (nenhuma outra parte do código importa esses dois módulos).

---

## 4. Camada agêntica

&emsp; Implementada como esqueleto simplificado, exatamente na hierarquia do ADR-004: orquestrador → agente → serviços de evidência/golden set → Bedrock (opcional).

### 4.1. Fluxo de um diagnóstico (`POST /incidents/:id/diagnose`)

```text
1. routes/incidents.js recebe a chamada, delega ao orquestrador
2. orchestrator busca incidente + evidências (evidenceService, 1 Query no GSI)
3. orchestrator monta a assinatura do incidente e consulta a golden set
      ├─ achou caso curado  → hipótese/score determinísticos, source="golden-set"
      └─ não achou          → delega ao agent, source="agent"
4. agent chama mlService.analyze(...) como ferramenta, monta a hipótese
5. orchestrator grava a hipótese de volta na tabela operacional (auditoria)
6. orchestrator pede a bedrockService uma explicação em linguagem natural
      ├─ BEDROCK_ENABLED=true e a chamada funciona → explicação do Bedrock
      └─ desligado ou falhou                        → fallback por template
7. resposta final: { hypothesis, score, evidence, source, explanation, explanationSource }
```

&emsp; A regra central do ADR-004 — "se o Bedrock cair, o orquestrador ainda devolve hipótese, score e evidências em formato estruturado" — está implementada em `bedrockService.explain`: qualquer falha (indisponibilidade no AWS Academy, throttle, timeout) é capturada e cai no fallback por template, nunca propaga exceção. `BEDROCK_ENABLED=false` é o padrão neste ambiente.

### 4.2. Módulo de ML

&emsp; `services/mlService.js` é o "mini script" pedido: recebe qualquer entrada e devolve sempre a mesma análise fixa (`{ anomalyScore, label, confidence, model: "mock-v0" }`). O agente o usa como uma ferramenta de investigação; o contrato de entrada/saída é o que importa — o time troca a implementação por um modelo de verdade sem mudar quem o chama.

### 4.3. Golden set: leitura livre, escrita restrita a um caminho

&emsp; A tela de Evidências introduziu um fluxo que o esqueleto original não previa: um especialista pode **confirmar ou refutar** a hipótese de um incidente (`PATCH /incidents/:id/hypothesis/review`). Confirmar promove o caso à golden set — é exatamente o mecanismo de curadoria humana do ADR-005 ("o que transforma o feedback humano em melhoria de verdade").

&emsp; Isso é a única exceção à regra de "golden set é só leitura" (ver também Seção 8.1): `goldenSetTable.putCurated` só é chamado por `goldenSetService.promoteCase`, que só é chamado pela rota de revisão — nunca pelo orquestrador ou pelo agente — e essa rota exige sessão autenticada (Seção 5). Refutar uma hipótese nunca escreve na golden set.

&emsp; Essa exceção não enfraquece a proteção da Seção 8.1 — é o outro lado dela. O risco que o ADR-002 endereça é o **job de ingestão** sobrescrever a golden set automaticamente, e esse job roda em um deploy inteiramente separado, sem importar nada de `apps/backend/api` — continua fisicamente sem como escrever ali. Dentro da API, a escrita é sempre uma ação explícita de uma pessoa autenticada: `reviewedBy` vem do e-mail da sessão verificada por `requireAuth`, nunca do corpo da requisição — exatamente o mecanismo de "curadoria por pessoas" do ADR-002/ADR-005.

---

## 5. Autenticação e controle de acesso

&emsp; Implementação mínima para fechar o fluxo de login que o frontend já espera (`lib/auth.ts`), sem SSO/Cognito real nesta fase.

<div align="center">

<sup>Tabela 5: Mecanismo de autenticação</sup>

| Item | Implementação |
|:---|:---|
| Credenciais | Usuário/senha fixos por variável de ambiente (`AUTH_USER_EMAIL`, `AUTH_USER_PASSWORD`) |
| Sessão | Cookie `httpOnly`, `sameSite=lax`, assinado com HMAC-SHA256 (`src/auth/session.js`) |
| Verificação | `requireAuth` (middleware) valida a assinatura do cookie com `crypto.timingSafeEqual`, popula `req.userEmail` |
| Rotas protegidas | Só `PATCH /incidents/:id/hypothesis/review` (escreve na golden set quando confirmada) |
| SSO | Stub explícito (`GET /auth/sso` → `501`), não implementado nesta fase |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

---

## 6. Contrato de rotas da API

<div align="center">

<sup>Tabela 6: Rotas implementadas</sup>

| Método | Rota | Autenticação | Descrição |
|:---|:---|:---|:---|
| GET | `/health` | — | Health check |
| POST | `/auth/login` | — | Login com o usuário fixo ou com conta registrada; define cookie de sessão |
| POST | `/auth/register` | — | Cria conta (nome, e-mail, senha com hash scrypt) e já abre a sessão; 409 para e-mail repetido |
| GET | `/auth/sso` | — | Stub (`501`) |
| GET | `/api/v1/incidents` | — | Lista incidentes (filtros: `window`, `deviceType`, `region`, `appVersion`) |
| GET | `/api/v1/incidents/:id` | — | Detalhe de um incidente |
| GET | `/api/v1/incidents/:id/evidence` | — | Evidências do incidente, com `strength` (`forte`/`neutra`/`contra`) |
| GET | `/api/v1/incidents/:id/hypothesis` | — | Hipótese mais recente do incidente |
| PATCH | `/api/v1/incidents/:id/hypothesis/review` | **Sim** | Confirma/refuta a hipótese; confirmar promove à golden set |
| POST | `/api/v1/incidents/:id/diagnose` | — | Dispara o diagnóstico (orquestrador → golden set ou agente) |
| GET | `/api/v1/golden-set` | — | Busca um caso curado por assinatura (`?signature=`) |
| POST | `/api/v1/ml/analyze` | — | Módulo de ML mockado — contrato fixo |
| GET | `/api/v1/dashboard/summary` | — | Resumo agregado dos incidentes para a tela inicial |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; O resumo do dashboard (`/dashboard/summary`) e a tela de Monitoramento **não** replicam métricas de telemetria bruta (taxa de erros, latência p95, saúde do pipeline de ingestão) presentes nos mocks originais do frontend — essas métricas viriam do job de ingestão, fora do escopo deste sprint, e foram deliberadamente omitidas em vez de simuladas.

---

## 7. Infraestrutura AWS provisionada

&emsp; A infraestrutura existente antes deste sprint cobria só o job de ingestão. Tudo abaixo foi criado do zero, de forma aditiva — nenhum recurso do job foi alterado ou removido.

<div align="center">

<sup>Tabela 7: Recursos AWS criados neste sprint</sup>

| Recurso | Nome | Observação |
|:---|:---|:---|
| Tabelas DynamoDB | `monitoracao-operacional`, `monitoracao-golden-set` | Seção 2 |
| Repositório ECR | `monitoracao-api` | Imagem publicada como `:v1` |
| Task Definition (ECS) | `monitoracao-api-task` | `LabRole` como execution e task role (única opção neste ambiente — Seção 8.1) |
| Security Group | `monitoracao-api-sg` | Dedicado; só libera a porta do container a partir do SG do ALB compartilhado |
| Target Group | `monitoracao-api-tg` | Porta do container, health check em `/health` |
| Regra de listener | prioridade 10 no ALB `data-ingestion-alb` | Encaminha `/api/*`, `/auth/*`, `/health` para `monitoracao-api-tg`; a ação padrão do listener, que serve o job, não foi alterada |
| Serviço ECS | `monitoracao-api-service` | No mesmo cluster do job (`data-ingestion-cluster`), serviço independente |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; Testado publicamente pelo DNS do ALB compartilhado, com confirmação de que a rota do job de ingestão continuou respondendo normalmente após a mudança.

### 7.1. Automação de entrega

&emsp; O pipeline de CI/CD descrito nesta seção foi utilizado durante a Sprint 2. Ele foi descontinuado na Sprint 4, juntamente com seus scripts de credenciais GitLab; merges não publicam imagens nem atualizam o ECS automaticamente. Para o fluxo vigente, use o provisionamento manual documentado no [`README`](../../README.md).

---

## 8. Decisões técnicas e riscos aceitos

### 8.1. IAM — sem separação de role possível no AWS Academy

&emsp; O ADR-002 pede IAM separado entre o job de ingestão e a API, para que o job nunca tenha permissão de escrita na golden set. Testado neste sprint: `iam:CreateRole` retorna `AccessDenied` na conta de laboratório — só é possível usar a role pré-provisionada `LabRole` para tudo. **Consequência**: a proteção da golden set não é imposta por IAM, é imposta por código (Seção 4.3) e por revisão — um risco aceito e documentado do ambiente AWS Academy, não do desenho da solução.

### 8.2. Estrutura em camadas em vez de acesso direto ao banco

&emsp; Cada tabela só é acessada através de um módulo dedicado (`services/*`), nunca diretamente pelas rotas ou pelo agente — sustenta tanto a auditabilidade exigida pelo ADR-004 quanto a proteção de escrita da golden set (Seção 8.1), já que a barreira de código é a única linha de defesa disponível neste ambiente.

### 8.3. Escopo deliberadamente fora deste sprint

&emsp; Ficaram de fora: saúde do pipeline de ingestão (tela `/monitoramento`), gráfico de buffering e linha do tempo de mudanças correlacionadas (tela `/evidencias`), e as métricas de telemetria bruta do resumo do dashboard — todas dependem de dados que só existiriam depois que o job de ingestão estivesse rodando de verdade.

---

## 9. Plano e execução de testes de integridade

&emsp; Sem suíte automatizada ainda, a validação foi feita por um roteiro manual reexecutável contra o DynamoDB real (não usa mock), cobrindo as duas tabelas, as três camadas (`services`/`orchestrator`/`agent`) e as rotas HTTP de ponta a ponta. Cada execução parte de um estado conhecido: a tabela operacional é limpa e re-semeada via `npm run seed`.

### 9.1. Núcleo da API

<div align="center">

<sup>Tabela 8: Casos de teste do núcleo da API</sup>

| # | Teste | Resultado esperado |
|:---:|:---|:---|
| 1 | Health check | `200`, `{"status":"ok"}` |
| 2 | Listar incidentes | 4 incidentes (os 4 semeados) |
| 3 | Detalhe de incidente | campos corretos (`urgency: "P1"`, `component: "Player"`) |
| 4 | Evidências do incidente | 2 evidências |
| 5 | Incidente inexistente | `404` |
| 6 | Golden set — assinatura existente | `expected_score: 0.85` |
| 7 | Golden set — sem assinatura | `400` |
| 8 | ML mockado | contrato fixo (`model: "mock-v0"`), ecoa as chaves recebidas |
| 9 | Login — credenciais corretas | `200` + `Set-Cookie` |
| 10 | Login — credenciais erradas | `401` |
| 11 | Diagnóstico — bate com golden set | `source: "golden-set"`, `score: 0.85` |
| 12 | Diagnóstico — sem match, cai no agente | `source: "agent"`, `score: 0.6` (do ML mock) |
| 13 | Diagnóstico — incidente inexistente | `404` |
| 14 | Resumo do dashboard | `stats` agregados batem com os 4 incidentes |
| 15 | Contagem final da operacional | 11 (base) + 2 diagnósticos (testes 11–12) = **13** |
| 16 | Golden set permanece intocada | **3, sem alteração** |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; O teste 16 é o mais importante do conjunto: mesmo depois de rodar os dois fluxos de diagnóstico (11 e 12), a golden set precisa continuar com a mesma contagem de antes — é a confirmação prática, não só teórica, de que a proteção por código (Seção 8.1) segura.

### 9.2. Revisão de hipótese e curadoria

<div align="center">

<sup>Tabela 9: Casos de teste do fluxo de revisão da tela de Evidências</sup>

| # | Teste | Resultado esperado |
|:---:|:---|:---|
| 1 | Evidência inclui `strength` | `"forte"`/`"neutra"`/`"contra"` presentes |
| 2 | `GET /hypothesis` antes de diagnosticar | `404` |
| 3 | `POST /diagnose` cria hipótese (agente) | `source: "agent"` |
| 4 | `GET /hypothesis` depois | hipótese retornada, `reviewStatus` ainda ausente |
| 5 | `GET /golden-set?signature=...` antes de confirmar | `404` (caso novo, sem curadoria) |
| 6 | `PATCH /hypothesis/review` sem cookie | `401` |
| 7 | `POST /auth/login` | `200` + cookie |
| 8 | `PATCH /hypothesis/review` com cookie, `confirmed` | `reviewStatus: "confirmed"`, `reviewedBy` = e-mail da sessão |
| 9 | `GET /golden-set?signature=...` depois de confirmar | caso promovido aparece, `curated_by` = e-mail da sessão |
| 10 | `PATCH /hypothesis/review` com `refuted` num incidente já presente na golden set | `reviewStatus: "refuted"` |
| 11 | Golden set do caso refutado | **inalterada** (mesmo score do seed) |
| 12 | `status` inválido no review | `400` |
| 13 | Contagem final da golden set | 3 (seed) + 1 (promovido no teste 9) = **4** |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; O teste 11 é o par do teste 16 do ciclo anterior: confirma que só `confirmed` aciona `promoteCase` — `refuted` passa pela mesma rota autenticada e não toca a golden set.

---

## 10. Conexão com o frontend

&emsp; O frontend consome as duas APIs do repositório, cada uma no seu domínio: esta API (Seção 6) responde por incidentes, evidências, hipótese e revisão; a API Flask (`apps/basica/backend`) responde pela telemetria bruta — QoE, erros, segmentações e séries no tempo. Toda leitura passa por `apps/frontend/lib/data/client.ts`, que conhece as duas bases de URL e entrega às telas um `Resource<T>` com a procedência (`api`, `exemplo` ou `indisponivel`), a completude (`measured`, `partial`, `unavailable`) e os avisos do que não pôde ser preenchido.

<div align="center">

<sup>Tabela 9: Fontes de dados por tela</sup>

| Tela | Fonte real | Sem fonte nesta fase |
|:---|:---|:---|
| Visão Geral | Flask (`realtime/overview`, `qoe/metrics`, `errors/summary`, `qoe/timeseries`) + esta API (`GET /incidents`) | Linha de base e detecção de anomalia |
| Incidentes | Esta API (`GET /incidents`); o gráfico por horário agrega a própria listagem | Série contínua de dispositivos afetados |
| Evidências | Esta API (`GET /incidents/:id`, `/evidence`, `/hypothesis`; `PATCH /hypothesis/review`) + Flask (`qoe/timeseries`) | Concentração por recorte, linha do tempo de mudanças |
| Eventos | Flask (`qoe/timeseries`, contagem de eventos por intervalo) | As seis categorias de evento individual |
| Monitoramento | — | Taxa, latência, cobertura, fila e DLQ (sem instrumentação de execução; fila inexistente por desenho), mapa por UF |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; **Configuração.** `NEXT_PUBLIC_API_BASE_URL` aponta para esta API e `NEXT_PUBLIC_TELEMETRY_API_BASE_URL` para a Flask (ver `apps/frontend/.env.example`). Sem as variáveis, ou quando uma leitura falha, o painel cai para o conjunto de exemplo **apenas fora de produção** e declara isso na interface; em produção, cada bloco sem fonte mostra um estado explícito de indisponibilidade com o motivo — nenhum componente volta silenciosamente ao mock, conforme o contrato do dashboard. Localmente, esta API ocupa a porta 3000, então o Next sobe em outra (`next dev -p 3001`, que é o valor de `FRONTEND_ORIGIN` no `.env.example` da API).

&emsp; **Sessão.** As leituras desta API vão com `credentials: "include"`; o cookie assinado do `POST /auth/login` acompanha a revisão de hipótese, que é a única escrita do painel. Um `401` na revisão aparece na tela como sessão expirada, com o caminho de volta ao login.

&emsp; **O que o `map` corrige.** As rotas desta API devolvem o item como está no DynamoDB; a projeção campo a campo no frontend (`incidents-resource.ts`, `evidence-resource.ts`) é o que impede `pk`, `sk`, `trace_id` e `ttl` de chegarem à tela. Dois rótulos foram corrigidos na integração para não afirmarem medição que não existe: o cartão "Latência p95" virou "Tempo de início (p95)" (a grandeza medida é VST) e o detalhe do incidente fala em dispositivos, não sessões (é o que o campo `devices` conta).

&emsp; A página de detalhe de incidente (`app/(painel)/incidentes/[id]`) segue inexistente; o caminho de investigação é `/evidencias?incidente=<id>`, que a lista de incidentes aponta.

---

## 11. Pendências e próximos passos

- Conectar `apps/frontend` às rotas reais (Seção 10).
- Build + push de uma nova versão da imagem (`:v2`) e nova revisão da Task Definition — o ambiente publicado no ECS ainda roda a `:v1`, sem as rotas de hipótese/revisão da Seção 4.3.
- Promover o roteiro manual de testes (Seção 9) para uma suíte automatizada, aproximando o projeto do RNF12 (cobertura mínima de testes) descrito em [`requisitos.md`](../sprint1/requisitos.md).
- Reavaliar a proteção da golden set (Seção 8.1) caso o projeto saia do ambiente AWS Academy e ganhe permissão para criar roles IAM próprias.
- Documentação de arquitetura consolidada (ADRs) e documentação do frontend seguem em arquivos próprios, fora do escopo deste documento.

---

## 12. Referências

GRUPO GLOBO. **Termo de Abertura de Projeto (TAPI)** — Turma 15, Ciência da Computação, Módulo 7. Inteli, 2026.

Ver também [`arquitetura-inicial.md`](arquitetura-inicial.md) (decisões de arquitetura do MVP).

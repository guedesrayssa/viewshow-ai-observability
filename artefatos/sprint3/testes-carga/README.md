# Suíte de carga — API de consulta atual + esqueleto de Ingestão

Sucessora de [`artefatos/sprint2/testes-carga`](../../sprint2/testes-carga), que
fica intocada como registro histórico daquela rodada (mirava rotas que não
existem mais depois do refactor que colapsou os microsserviços num monólito
modular). Esta pasta testa o contrato **atual** de `apps/backend/api` e
desconsidera por completo `apps/basica` — aquele Flask não faz parte da
arquitetura aprovada ([`artefatos/arquitetura/visao-geral.md`](../../arquitetura/visao-geral.md))
e está desconectado do frontend hoje (só existe um `NEXT_PUBLIC_API_BASE_URL`).

## O que existe nesta pasta

| Arquivo | O que faz | Roda hoje? |
| --- | --- | --- |
| `k6/consultas.js` | Requisição/resposta em `/api/v1/incidents`, `/diagnosis`, `/dashboard/overview`, `/monitoring/overview` | **Sim** |
| `k6/auth-check.js` | RNF04 — confere 401 sem sessão/com cookie inválido em cada rota, incluindo `reanalyze` e as três de `imports` | **Sim** (documenta os gaps atuais, não finge que não existem) |
| `k6/ingestao-batch.js` | Drenagem de 150 mil eventos, acúmulo de lotes represados, frescor ponta a ponta | **Não** — a rota de import já existe, mas o adaptador é fail-closed por design (503 `FEATURE_UNAVAILABLE`); o script se auto-verifica em `setup()` e aborta com uma mensagem clara em vez de fingir medir algo |
| `k6/rodadas.sh` | Bateria `smoke → load → breakpoint → estresse → spike → soak` de `consultas.js` | Sim |
| `k6/lib/session.js` | Forja o cookie de sessão (HMAC, mesmo algoritmo de `SessionCodec`) compartilhado entre os três scripts | — |
| `seed-carga.js` | Cópia versionada do seed de carga (a canônica, executável, vive em `apps/backend/api/scripts/seed-carga.cjs`) — também popula `dashboard/overview` e `monitoring/overview` | Sim |

## Autenticação mudou — leia antes de rodar qualquer coisa

Não existe mais `POST /auth/login` com e-mail/senha. A identidade agora é
federada (Cognito/OIDC): `GET /auth/login`/`GET /auth/callback` existem, mas
hoje ambas respondem `503 FEATURE_UNAVAILABLE` (o adaptador
`ConfiguredIdentityProvider` sempre retorna `null`) — não há como logar via
HTTP puro, nem localmente.

`k6/lib/session.js` contorna isso forjando o cookie de sessão diretamente,
replicando o algoritmo de `SessionCodec`
(`apps/backend/api/src/modules/auth/domain/session.ts`) — o mesmo caminho que
`apps/backend/api/tests/live-api.e2e.test.ts` usa internamente. **Todo `k6
run` desta pasta agora exige `-e AUTH_COOKIE_SECRET=<mesmo segredo do
processo da API sob teste>`** (mínimo 32 caracteres); sem isso, toda chamada
autenticada volta `401` mesmo com o resto do script correto.

## Por que o sprint2 não podia simplesmente ser reaproveitado

`consultas.js` e `auth-check.js` do sprint2 apontavam para rotas que não
existem mais (`/dashboard/summary`, `/incidents/:id/evidence`,
`POST /incidents/:id/diagnose`, `/golden-set`) — rodar contra a API de hoje
daria 404 em quase tudo. `scripts/seed-carga.js` também estava quebrado:
dependia de um módulo `src/db/keys.js` que não existe mais desde o mesmo
refactor (`require` falhava com "Não encontrei src/db/keys.js"). As três
correções estão nesta pasta; o comportamento de carga (executores,
thresholds, filosofia de modelo aberto) foi preservado do sprint2, só as
rotas e o esquema de chaves foram realinhados.

## Antes de rodar: semear

```bash
cd apps/backend/api
CLEAN=1 node scripts/seed-carga.cjs
# 300 incidentes ≈ 2.500 itens, distribuídos pelas últimas 25 horas, mais
# alguns snapshots de dashboard/overview e monitoring/overview
```

`CLEAN=1` remove itens com `pk` começando em `INC#` ou `VIEW#`; contas de
usuário são preservadas. **O seed envelhece**: os buckets/snapshots são
calculados no instante do seed. `window=15m`/`1h` só encontram dado de
incidentes por ~1 h depois de rodar; os snapshots de overview/monitoring
cobrem os presets de 15m a 24h por tempos diferentes (ver aviso impresso pelo
próprio script ao final).

## Rodando

```bash
cd artefatos/sprint3/testes-carga/k6
export BASE_URL=http://localhost:3000   # ou o ALB/domínio do ambiente testado
export AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob teste>   # 32+ chars

k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET auth-check.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=load consultas.js   # a rodada do relatório
./rodadas.sh                                              # bateria completa (lê AUTH_COOKIE_SECRET do ambiente)
```

## Duas limitações reais do backend atual — leia antes de interpretar os números

### 1. Rate limit de 180 req/min por IP

`src/app.ts` aplica `rateLimiter(180)` a **todas** as rotas depois de
`/health`/`/metrics`, contado por IP de origem. Um gerador k6 rodando de uma
única máquina é um único IP: isso teta o throughput observável em **~3 req/s**,
bem abaixo dos 137 req/s do RNF14 — mesmo que a API aguente mais que isso.
`consultas.js` conta esses 429 numa métrica própria (`rate_limited_total`) e
avisa no resumo em vez de deixar o número parecer "a API está lenta" quando na
verdade é o limitador de borda agindo. Isto **não foi contornado** (o escopo
deste trabalho é só o k6, não alterar o backend) — para medir capacidade real
acima de ~3 req/s, o time do backend precisa rodar o teste distribuído
(múltiplas origens) ou ajustar/suspender o limite só na janela do teste.

### 2. `dashboard/overview` e `monitoring/overview` envelhecem rápido

MUDOU: ao contrário do que uma versão anterior deste README dizia, essas duas
rotas **não** dependem da Ingestão futura — o formato de projeção
(`VIEW#OVERVIEW#...`/`VIEW#MONITORING#...`) já existe e é lido por
`dynamodb-dashboard-read-repository.ts` hoje. `seed-carga.js` grava alguns
snapshots dessas projeções a cada seed. O que continua real: os snapshots
envelhecem (cada um só é encontrado enquanto sua idade cabe dentro do
`window` pedido), e sem seed recente (ou depois que os snapshots saem da
janela) a resposta volta a ser `503 DATA_UNAVAILABLE`. Por isso `consultas.js`
continua tratando **200 ou 503** como resultado esperado nessas duas rotas —
nenhum dos dois é falha do teste. `GET /api/v1/incidents` e seus detalhes
(`/diagnosis`, `/events`) leem itens físicos diretamente e envelhecem de forma
independente (janela de 25h do seed de incidentes), por isso o teste continua
exigindo 200 de verdade nessas rotas.

## O que fica pendente (`ingestao-batch.js`) e por quê

MUDOU: a rota HTTP de import **já existe** em `src/app.ts` (`POST
/api/v1/imports`, `POST /api/v1/imports/:id/complete`, `GET
/api/v1/imports/:id`), mas o adaptador por trás dela
(`UnavailableImportControl`) é fail-closed por construção — toda chamada
autenticada e com corpo válido responde incondicionalmente `503
FEATURE_UNAVAILABLE` ("a importação requer S3 e uma tarefa de ingestão
configurados"), documentado em `apps/backend/README.md`. `k6/ingestao-batch.js`
já implementa a lógica completa dos três cenários pedidos:

- **drenagem** — dispara uma janela de 150 mil eventos (10 mil/min × 15 min)
  e mede o tempo até `ImportJob` concluir; threshold: bem abaixo de 15 min;
- **acúmulo** — dispara 2, 3 ou 4 janelas em sequência (`-e BACKLOG_BATCHES=N`)
  e mede o tempo de recuperação;
- **frescor** — mede o delta entre o disparo e o dado aparecer em
  `/api/v1/dashboard/overview` (via `meta.freshness[].observedThrough`).

`setup()` confirma contra o `BASE_URL` real que a rota responde `503
FEATURE_UNAVAILABLE` (o estado fail-closed esperado); se responder `404`, a
rota mudou de novo, e qualquer outra resposta significa que o adaptador saiu
do estado fail-closed. Nesse último caso, ajuste `ENDPOINTS.*` e a forma da
resposta assumida em `triggerImport()`/`waitForCompletion()` (paths e request
já seguem o contrato real; só a resposta de sucesso continua sendo suposição,
porque o adaptador nunca chega a produzi-la hoje) — a lógica de carga,
polling e métricas já está pronta.

**Achado a lembrar, fora do escopo do k6:** os três handlers de import em
`src/app.ts` nunca chamam `response.json()`/`.end()` no caminho de sucesso —
invisível hoje porque o adaptador sempre lança antes de chegar lá, mas vai
travar a requisição sem resposta no dia em que o adaptador real resolver sem
lançar.

## Verificação de controle de acesso (RNF04) — o que o script revela hoje

MUDOU: além de `PATCH .../hypotheses/:id/review`, agora também chamam
`auth.sessions.verify()` em `src/app.ts`: `POST .../reanalyze` e as três
rotas de `/api/v1/imports*`. `auth-check.js` cobre as sete. Todas as rotas de
leitura (`incidents`, `dashboard/overview`, `monitoring/overview`,
`diagnosis`, `events`) continuam públicas — respondem sem qualquer cookie.
Isso é o mesmo gap já documentado no sprint2 ("é esperado que a execução
revele o gap do RNF04 até a proteção ser aplicada às demais rotas"); ele
continua existindo hoje.

Uma rota tem um problema **diferente e mais grave**: `GET
/api/v1/incidents/:id/events/:eventId` (`incident_event_detail` na matriz) nem
tenta verificar sessão — o handler chama `incidents.event()`, que sempre lança
503 antes de qualquer checagem, com ou sem cookie. `auth-check.js` marca essa
rota separadamente (fora de `objetivo:rnf04`) para não confundir "ainda não
tem RNF04 aplicado" com "não tem guarda nenhuma".

As rotas de import/reanalyze validam corpo/header **antes** de checar sessão
— por isso `auth-check.js` sempre manda corpo/headers válidos nelas (senão
"sem cookie" mediria 400 de validação, não o controle de acesso).

## Limitações a declarar no relatório

1. **Volume sintético.** 300 incidentes num seed determinístico não
   reproduzem a distribuição real de produção.
2. **Capacidade real da API de consulta é desconhecida acima de ~3 req/s**
   enquanto o rate limit por IP não for contornado (ver acima) — os modos
   `load`/`breakpoint`/`spike`/`estresse` medem principalmente o limitador,
   não a API, até isso ser resolvido.
3. **`dashboard/overview` e `monitoring/overview` só têm dado real logo após
   o seed** — os snapshots envelhecem e saem da janela pedida; um 503 fora
   dessa janela é o caminho normal, não uma falha de ambiente.
4. **Ingestão, drenagem, acúmulo e frescor ponta a ponta não são medíveis
   ainda** — a rota de import existe, mas o adaptador (S3 + tarefa de
   ingestão) continua fail-closed por design nesta branch.
5. **`auth-check.js` reprova por design** enquanto o RNF04 não for aplicado
   às rotas de leitura — não é regressão deste teste, é o estado real do
   código.
6. **Autenticação é forjada, não federada.** `AUTH_COOKIE_SECRET` precisa ser
   o mesmo segredo do processo da API sob teste; isso mede o comportamento da
   API para uma sessão válida, não o fluxo de login Cognito/OIDC em si (que
   está fora do escopo do k6 e, hoje, fail-closed).

## Documentos relacionados

- [Visão geral da arquitetura](../../arquitetura/visao-geral.md)
- [Ingestão e dados](../../arquitetura/ingestao-e-dados.md)
- [Status de implementação](../../arquitetura/status-implementacao.md)
- [Suíte anterior (histórica)](../../sprint2/testes-carga/README.md)

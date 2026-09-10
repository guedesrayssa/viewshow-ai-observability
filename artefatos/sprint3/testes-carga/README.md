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
| `k6/auth-check.js` | RNF04 — confere 401 sem sessão/com cookie inválido em cada rota | **Sim** (documenta os gaps atuais, não finge que não existem) |
| `k6/ingestao-batch.js` | Drenagem de 150 mil eventos, acúmulo de lotes represados, frescor ponta a ponta | **Não** — endpoint de importação não existe ainda; o script se auto-verifica em `setup()` e aborta com uma mensagem clara em vez de fingir medir algo |
| `k6/rodadas.sh` | Bateria `smoke → load → breakpoint → estresse → spike → soak` de `consultas.js` | Sim |
| `k6/lib/session.js` | Login compartilhado entre os três scripts (evita repetir a mesma chamada três vezes) | — |
| `seed-carga.js` | Cópia versionada do seed de carga (a canônica, executável, vive em `apps/backend/api/scripts/seed-carga.js`) | Sim |

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
CLEAN=1 node scripts/seed-carga.js
# 300 incidentes ≈ 2.500 itens, distribuídos pelas últimas 25 horas
```

`CLEAN=1` remove só itens com `pk` começando em `INC#`; contas de usuário são
preservadas. **O seed envelhece**: os buckets são calculados no instante do
seed. `window=15m`/`1h` só encontram dado por ~1 h depois de rodar.

## Rodando

```bash
cd artefatos/sprint3/testes-carga/k6
export BASE_URL=http://localhost:3000   # ou o ALB/domínio do ambiente testado

k6 run -e BASE_URL=$BASE_URL -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL auth-check.js
k6 run -e BASE_URL=$BASE_URL -e MODE=load consultas.js   # a rodada do relatório
./rodadas.sh                                              # bateria completa
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

### 2. `dashboard/overview` e `monitoring/overview` dependem da Ingestão

Os dois leem uma projeção (`VIEW#OVERVIEW#...`/`VIEW#MONITORING#...`) que só a
Ingestão publica (`apps/backend/ingestion-data`, ainda inexistente). Nenhum
seed pode popular essas projeções sem reimplementar parte do que é
responsabilidade daquele time (fórmulas versionadas, cobertura, watermark).
Por isso `consultas.js` trata **200 ou 503** como resultado esperado nessas
duas rotas — 503 `DATA_UNAVAILABLE` é o estado real e correto hoje, não uma
falha do teste. `GET /api/v1/incidents` e seus detalhes (`/diagnosis`,
`/events`) não têm essa dependência: leem itens físicos diretamente, por isso
o seed consegue alimentá-los e o teste exige 200 de verdade.

## O que fica pendente (`ingestao-batch.js`) e por quê

A arquitetura aprovada não define ingestão como uma API HTTP de eventos — é
uma tarefa batch ECS/Fargate (`sync` a cada 15 min, `backfill` para dump) sem
porta HTTP nenhuma. O único ponto de entrada HTTP previsto é o Backend
disparando essa tarefa (upload do dump pro S3 → `RunTask` → `ImportJob`
acompanhado até `COMPLETED`), e essa rota também não existe ainda em
`src/app.ts`. `k6/ingestao-batch.js` já implementa a lógica completa dos três
cenários pedidos:

- **drenagem** — dispara uma janela de 150 mil eventos (10 mil/min × 15 min)
  e mede o tempo até `ImportJob` concluir; threshold: bem abaixo de 15 min;
- **acúmulo** — dispara 2, 3 ou 4 janelas em sequência (`-e BACKLOG_BATCHES=N`)
  e mede o tempo de recuperação;
- **frescor** — mede o delta entre o disparo e o dado aparecer em
  `/api/v1/dashboard/overview` (via `meta.freshness[].observedThrough`).

Só que `setup()` primeiro confirma contra o `BASE_URL` real que o endpoint de
importação existe; se não existir (o caso hoje), o script para com uma
mensagem explicando exatamente isso, em vez de inventar uma resposta. Quando
a Ingestão e a rota de importação existirem, normalmente basta ajustar
`ENDPOINTS.*` no topo do arquivo (paths assumidos a partir de D9 em
`visao-geral.md`) para os nomes reais do contrato publicado — a lógica de
carga, polling e métricas já está pronta.

## Verificação de controle de acesso (RNF04) — o que o script revela hoje

Rodar `auth-check.js` hoje **falha de propósito** em várias rotas: só
`PATCH .../hypotheses/:id/review` chama `auth.sessions.verify()` em
`src/app.ts`. Todas as rotas de leitura (`incidents`, `dashboard/overview`,
`monitoring/overview`, `diagnosis`, `events`) são públicas — respondem sem
qualquer cookie. Isso é o mesmo gap que já estava documentado no sprint2
("é esperado que a execução revele o gap do RNF04 até a proteção ser aplicada
às demais rotas"); ele continua existindo hoje.

Uma rota tem um problema **diferente e mais grave**: `GET
/api/v1/incidents/:id/events/:eventId` (`incident_event_detail` na matriz) nem
tenta verificar sessão — o handler chama `incidents.event()`, que sempre lança
503 antes de qualquer checagem, com ou sem cookie. `auth-check.js` marca essa
rota separadamente (fora de `objetivo:rnf04`) para não confundir "ainda não
tem RNF04 aplicado" com "não tem guarda nenhuma".

## Limitações a declarar no relatório

1. **Volume sintético.** 300 incidentes num seed determinístico não
   reproduzem a distribuição real de produção.
2. **Capacidade real da API de consulta é desconhecida acima de ~3 req/s**
   enquanto o rate limit por IP não for contornado (ver acima) — os modos
   `load`/`breakpoint`/`spike`/`estresse` medem principalmente o limitador,
   não a API, até isso ser resolvido.
3. **`dashboard/overview` e `monitoring/overview` não têm dado real hoje** —
   qualquer 200 nessas rotas hoje seria coincidência de ambiente, não o
   caminho normal.
4. **Ingestão, drenagem, acúmulo e frescor ponta a ponta não são medíveis
   ainda** — dependem de `apps/backend/ingestion-data` e da rota de
   importação do Backend, nenhuma das duas implementada nesta branch.
5. **`auth-check.js` reprova por design** enquanto o RNF04 não for aplicado
   às rotas de leitura — não é regressão deste teste, é o estado real do
   código.

## Documentos relacionados

- [Visão geral da arquitetura](../../arquitetura/visao-geral.md)
- [Ingestão e dados](../../arquitetura/ingestao-e-dados.md)
- [Status de implementação](../../arquitetura/status-implementacao.md)
- [Suíte anterior (histórica)](../../sprint2/testes-carga/README.md)

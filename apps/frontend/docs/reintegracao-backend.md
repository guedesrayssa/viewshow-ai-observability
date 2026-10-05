# Reintegração com o backend: o que mudou no front

Este documento resume a reestruturação dos fluxos do painel (branch
`feat/fluxo-front`) do ponto de vista de quem mantém a API. Nenhum arquivo do
backend foi alterado: tudo aqui é como o front passou a **consumir** a API e o
que ainda depende de mudança do lado de vocês.

## 1. Rotas do painel

Eventos e Evidências deixaram de ser telas soltas e viraram abas do incidente.
O painel é exportado como HTML estático, então o incidente vai na query string.

| Tela | Rota |
| --- | --- |
| Lista de incidentes | `/incidentes?periodo=&prioridade=&estado=&ordem=&busca=&pagina=&itens=` |
| Feed global de eventos | `/incidentes/feed-eventos?evento=` |
| Diagnóstico do incidente | `/incidentes/detalhe?incidente=<id>&relacao=&forca=&pagina=` |
| Eventos do incidente | `/incidentes/detalhe/eventos?incidente=<id>&evento=<eventId>` |
| Linha do tempo do incidente | `/incidentes/detalhe/linha-do-tempo?incidente=<id>` |
| Importações e sincronização ARGUS | `/dados/importacoes` |

`/eventos` e `/evidencias` continuam existindo só como redirecionamento para as
rotas novas. **Se o backend gera links para o painel** (e-mail, notificação,
ServiceNow), use as rotas da tabela, com o `id` interno do incidente
(`inc_…`) em `incidente=`.

## 2. Como cada endpoint é consumido agora

### `GET /api/v1/incidents`

- Sempre com `limit=100`. "Últimas 24 horas" vai como `window=24h` e "Todo o
  período" como `window=all`: a API recorta por `startedAt` **antes** de
  aplicar o limite. "Mais de 24 horas" não tem janela na API (e um `from`/`to`
  cobre no máximo 31 dias), então é lido com `window=all` e recortado no
  front. O front repete o recorte por `startedAt` nos três casos, como
  proteção.
- Envia `priority`, `status` e `sort=priority` só quando a dimensão aparece em
  `capabilities.filtering.supportedDimensions`. Filtros ausentes dessa lista
  somem da tela. `deviceType`, `region` e `appVersion` não são mais enviados:
  a API responde **422** `UNSUPPORTED_FILTER_COMBINATION` para eles.
- Lê `page.hasMore` para avisar que a lista foi truncada em 100. Em "Mais de
  24 horas" o aviso diz que parte dos incidentes antigos pode não aparecer,
  porque o recorte é feito sobre os 100 que chegaram.
- Usa `number` como código legível (`INC-E2E-0044`); sem ele, cai para o `id`.

### `GET /api/v1/incidents/{id}/diagnosis`

- Uma leitura por aba (Diagnóstico e Linha do tempo), e também para o
  cabeçalho da aba Eventos. Antes eram duas leituras na mesma tela.
- O front já desenha, quando a API preencher:
  - `diagnosis.hypotheses[]` (usa a de `primaryHypothesisId` ou a primeira),
    com `probability` em 0–1. **`probability: null` é tratado** ("Confiança
    não medida"), mas o contrato atual não aceita `null`.
  - `charts.buffering { points[{timestamp,value}], marker{timestamp,label} }`,
    `charts.concentrations[{label,percentage}]` e `charts.concentrationNote`.
  - `timeline[{timestamp,label,source,tone}]` e
    `changes[{label,cause,percentage,tone}]` na aba Linha do tempo.
  - `evidence[]` com `relation` (`supports`/`contradicts`/`context`),
    `strength` (`strong`/`moderate`/`weak`, sem colapsar em "neutra"),
    `correlation.ruleVersion`, `timeDistanceSeconds` e `matchedFields`, que
    viraram campos estruturados no detalhe da evidência.

### `PATCH /api/v1/incidents/{id}/hypotheses/{hypothesisId}/review`

Envia `{ status, expectedVersion }` com a versão lida no diagnóstico. Trata
401/403 (sessão), 409 (revisada por outra sessão) e a mensagem de
`error.message` nos demais casos.

### `POST /api/v1/incidents/{id}/reanalyze` (novo no front)

Botão "Reanalisar" no Diagnóstico. Envia o header `Idempotency-Key` (UUID por
clique) e trata:

- 202: aceito, e o diagnóstico novo aparece numa leitura seguinte;
- `error.code = FEATURE_UNAVAILABLE`: mensagem de que a reanálise não está
  habilitada no ambiente;
- 409: já existe uma análise em andamento;
- 401/403: sessão expirada.

### `GET /api/v1/events` e `GET /api/v1/incidents/{id}/events`

- Período: "Todo o período" vai como `window=all`. Os demais vão como
  `from`/`to` explícitos: "Últimas 24 horas" (de 24 horas atrás até agora),
  "Mais de 24 horas" (de 30 dias atrás até 24 horas atrás) e o "Intervalo
  personalizado".
- O `from`/`to` é calculado **uma vez**, na primeira página, e repetido
  idêntico em cada "Carregar mais". O cursor da API carrega uma impressão
  digital do intervalo (`cursorFingerprint` usa `from` e `to`): se o intervalo
  muda um segundo, a API responde 400 "O cursor é inválido para estes
  filtros". Pelo mesmo motivo o front não usa `window=24h` em eventos — a API
  resolve essa janela contra o relógio a cada chamada, e o cursor da primeira
  página nunca valeria na segunda.
- Filtros: `search` (com debounce de 350 ms), `category`, `sourceDataset`,
  `correlation` (só no feed global) e `sort=oldest` quando escolhido.
- Paginação: `limit=50` e `cursor` vindo de `page.nextCursor` ("Carregar
  mais"). O total mostrado é a soma de `categoryStats`.
- O gráfico de volume faz uma segunda leitura com **os mesmos filtros** e
  `limit=1`, lendo `volumeSeries`.
- `GET /events/{eventId}` e `GET /incidents/{id}/events/{eventId}` são usados
  quando o link traz `?evento=`.

### `GET /api/v1/imports`

A listagem (`limit=50`) só é chamada quando a tela Dados abre. Antes era
chamada em toda tela do painel.

### Falhas de leitura

Uma leitura que falha (4xx/5xx, ou 503 `DATA_UNAVAILABLE`) agora aparece como
**erro**, com a mensagem de `error.message`, e nunca como lista vazia ou
carregamento infinito. Mensagens de erro claras ajudam diretamente a tela.

## 3. O que falta do lado do backend

Em ordem de impacto no que a pessoa usuária vê:

1. **Diagnóstico real.** `incident-use-cases.ts` devolve `hypotheses: []`,
   `status: "not_started"`, `charts` vazios, `timeline: []` e `changes: []`
   fixos. O front está pronto para esses campos (seção 2).
2. **Revisão da hipótese.** O `PATCH …/review` responde sempre 503; o
   `writeReview` do repositório não é chamado.
3. **Reanálise.** O `POST …/reanalyze` responde sempre 503, mesmo com o
   publisher SQS injetado (o argumento `_reanalysis` é ignorado).
4. **Cursor de eventos com janela relativa.** Com `window=15m…24h`, o
   `from`/`to` resolvido muda a cada chamada e invalida o cursor emitido na
   página anterior. O front contorna enviando `from`/`to` fixos; o ideal é o
   cursor guardar o intervalo resolvido (ou a impressão digital usar o
   `preset`).
5. **Paginação de incidentes.** Aceitar `cursor` e devolver `page.nextCursor`
   (hoje `cursor` responde 400). Com isso o front troca o aviso "até 100" por
   "carregar mais".
6. **`probability` anulável** no contrato de hipótese.
7. **Monitoramento.** `GET /monitoring/overview` responde sempre 503.
8. **Itens do worker de análise.** O worker grava `EVIDENCE#…` com `trace_id`
   na mesma partição do incidente. O schema estrito da API rejeita esse campo
   e o diagnóstico inteiro do incidente passa a responder 503.

## 4. Seed temporário no Learner Lab

Para validar as telas, o dataset ativo foi trocado **temporariamente** por um
sintético (33 incidentes `INC-SEED-*`, 212 evidências, 432 eventos), com a
sincronização ARGUS pausada. O dataset real não foi alterado. Para voltar ao
original:

```bash
node apps/fullstack/.terraform-artifacts/seed-temporario/seed-temporario.cjs revert
```

O mesmo script aceita `status`. Os backups do ponteiro `CONTROL#DATASET/ACTIVE`,
do gate ARGUS e dos schedules ficam na mesma pasta (ignorada pelo git).

# Eventos e Evidências reais do ARGUS

## Objetivo

Disponibilizar na aplicação os registros reais já normalizados pelo `canonical-v2`, sem usar
fixtures ou seeds em produção. Todo registro elegível de `signal_bucket`, `live_event` e
`live_event_sde` deve produzir um Evento pesquisável. Um Evento só produz Evidência depois de
uma correlação explícita e rastreável com um Incidente.

O resultado deve permitir:

- consultar todos os Eventos do dataset ativo em um feed global paginado;
- consultar apenas os Eventos correlacionados a um Incidente;
- consultar as Evidências reais de um Incidente;
- distinguir claramente Evento não correlacionado, Evento correlacionado e Evidência;
- identificar origem, registro de origem, horário, dimensões, medidas, qualidade, freshness e
  disponibilidade do bruto;
- operar sem selecionar silenciosamente um Incidente padrão.

## Escopo

### Incluído

- projeção canônica de `SignalObservation` e `LiveEventContext` para Evento público;
- correlação determinística entre Evento e Incidente;
- criação de Evidência somente quando uma regra de correlação for satisfeita;
- feed global, consultas por Incidente, detalhe do Evento e diagnóstico com Evidências;
- paginação por cursor, filtros suportados, qualidade, freshness e rastreabilidade;
- atualização de contratos TypeScript, OpenAPI, API, frontend e testes;
- validação local com um dump ARGUS recente e E2E das telas Incidentes, Eventos e Evidências.

### Não incluído

- geração de hipóteses por IA;
- correlação probabilística, fuzzy matching ou inferência causal;
- reconstrução de eventos individuais de cliente que não existam no ARGUS;
- uso de fixture ou seed como fonte de produção;
- aplicação ou destruição de infraestrutura Terraform.

## Conceitos

### Evento

Evento é a representação pública e pesquisável de um registro canônico elegível. Ele não afirma
relação causal com um Incidente.

Fontes iniciais:

| Dataset ARGUS | Tipo canônico | Categoria pública |
| --- | --- | --- |
| `signal_bucket` | `SignalObservation` | `signal_observation` |
| `live_event` | `LiveEventContext` | `live_event` |
| `live_event_sde` | `LiveEventContext` | `live_event_context` |

Cada Evento preserva:

- `sourceSystem` e `sourceDataset`;
- `sourceRecordId`, derivado da chave natural canônica;
- `occurredAt` e `window`, sem fabricar horário ausente;
- `dimensions` e `measures` canônicos completos;
- `quality.status`, `quality.flags` e `observedThrough`;
- `raw.available` e `raw.reason`.

O identificador público é determinístico:

```text
evt_<base32(sha256("event:v1" + sourceSystem + sourceDataset + naturalKey))>
```

Ele não inclui a versão do dataset, portanto a mesma linha lógica mantém o ID após uma nova
importação. O item persistido continua vinculado à `datasetVersion` ativa.

Quando o horário de ocorrência não existir, como pode ocorrer em `live_event_sde`, o Evento é
publicado com `occurredAt = null`, recebe `MISSING_EVENT_TIMESTAMP` e permanece no feed global.
O `updatedAt` da origem pode ordenar fisicamente o item, mas não substitui o horário ausente no
contrato público.

### Correlação

Correlação é uma relação derivada e versionada entre Evento e Incidente. A janela temporal é
necessária, mas não é suficiente.

A regra validada com o dump real, `argus-explicit-v2`, exige simultaneamente:

1. Evento com `occurredAt` conhecido.
2. Distância temporal de no máximo o valor configurado antes ou depois de `Incident.openedAt`.
3. Pelo menos uma correspondência semântica, após `trim` e `casefold`, entre:
   - Evento: `source`, `entity`, `metric`, `channel`, `program`, `competition`, `sport`,
     `sdeId`, `eventKey` ou valores equivalentes presentes em `dimensions`;
   - Incidente: `business_service`, `cmdb_ci`, `category`, `subcategory`,
     `impact_component` ou `impact_component_value`.

O caso padrão exige igualdade exata. Para identificadores técnicos `source` e `entity`, a regra
também aceita `business_service`, `cmdb_ci` ou `impact_component_value` como token completo com
quatro ou mais caracteres. Assim, por exemplo, `Globoplay` corresponde a
`br1|tv.globoplay.com.br`, mas não a `mygloboplayx`. Não há fuzzy matching, score probabilístico
nem aproximação textual livre. Valores vazios não participam. A regra registra os campos que
coincidiram, o token aceito, a distância temporal e sua versão.

A configuração é `ARGUS_EVENT_CORRELATION_WINDOW_SECONDS`, padrão `18000` e limite máximo
`18000` segundos, isto é, cinco horas antes ou depois. Valores inválidos impedem a inicialização.

### Evidência

Uma Evidência é criada somente para uma correlação aceita por `argus-explicit-v2`. Ela possui ID
determinístico a partir de `eventId`, `incidentId` e `ruleVersion`, relação `context` e tipo
`argus_event_correlation`.

- uma correspondência semântica gera força `moderate`;
- duas ou mais correspondências geram força `strong`;
- a Evidência aponta para o Incidente;
- `hypothesisIds` fica vazio enquanto não houver hipótese materializada;
- uma futura associação a hipótese exigirá outra regra explícita e versionada.

Um Evento dentro da janela, mas sem correspondência semântica, continua não correlacionado e não
vira Evidência.

## Fluxo de dados

```text
ARGUS dump/live sync
        |
        v
canonical-v2 (23 tabelas, versionado)
        |
        +--> projetor canônico -> Eventos -> feed global paginado
        |
        +--> Incidentes canônicos
                 |
                 v
        correlacionador explícito
                 |
                 +--> vínculo Evento-Incidente
                 +--> Evidência do Incidente
```

O projetor e o correlacionador são unidades separadas. O projetor não precisa conhecer Incidentes.
O correlacionador consome Eventos normalizados e Incidentes normalizados, aplica a regra
configurada e persiste somente relações reproduzíveis.

## Persistência e rastreabilidade

As projeções pertencem à mesma `datasetVersion` do conjunto canônico. A publicação de um candidato
acontece antes da ativação, mantendo o comportamento atual de troca atômica do dataset ativo.

### Eventos por dia

```text
PK = DATASET#<version>#VIEW#EVENTS#DAY#<yyyymmdd>
SK = OCCURRED#<epoch-ms>#EVENT#<event-id>
```

Eventos sem `occurredAt` usam o instante de atualização somente na chave de ordenação e expõem
`occurredAt = null` no payload.

### Correlações e Evidências

```text
PK = DATASET#<version>#INCIDENT#<incident-id>
SK = EVENT#<epoch-ms>#<event-id>

PK = DATASET#<version>#INCIDENT#<incident-id>
SK = EVIDENCE#<epoch-ms>#<evidence-id>
```

Cada item armazena `requiredArchives`, `projectionVersion`, `formulaVersion`,
`materializationRevision`, `inputWatermarks`, `coverage` e `qualityFlags`. A escrita é idempotente
e falha diante de identidade igual com conteúdo divergente.

As projeções quentes respeitam a retenção vigente. O registro canônico continua arquivado no S3
por até 12 meses; o contrato informa quando o detalhe só está disponível no arquivo.

## API pública

### Feed global

```http
GET /api/v1/events
```

Parâmetros:

- `window` ou `from`/`to`;
- `search`;
- `category`;
- `sourceDataset`;
- `correlation=all|linked|unlinked`, padrão `all`;
- `sort=recent|oldest`;
- `limit=1..100`, padrão `50`;
- `cursor` opaco e vinculado à versão do dataset, filtros e ordenação.

O retorno contém `items`, `facets`, `page` e a qualidade no envelope padrão. Eventos não
correlacionados têm `correlation.status = "unlinked"`, nunca desaparecem silenciosamente.

### Eventos do Incidente

```http
GET /api/v1/incidents/{incidentId}/events
```

Usa a mesma forma de item e paginação do feed global, mas retorna somente vínculos persistidos para
o Incidente informado.

### Detalhe do Evento

```http
GET /api/v1/events/{eventId}
GET /api/v1/incidents/{incidentId}/events/{eventId}
```

A primeira rota é canônica. A segunda permanece como compatibilidade e também verifica o vínculo
com o Incidente.

### Evidências

```http
GET /api/v1/incidents/{incidentId}/diagnosis
```

O campo `evidence` passa a ser preenchido pelas Evidências correlacionadas reais. A ausência de
hipóteses não apaga Evidências; o diagnóstico permanece `not_started` ou `inconclusive` conforme o
estado materializado.

### Erros

- cursor inválido ou de outro dataset/filtro: `400 VALIDATION_ERROR`;
- Incidente ou Evento inexistente no dataset ativo: `404 NOT_FOUND`;
- projeção exigida ainda não publicada: `503 DATA_UNAVAILABLE`;
- filtro não sustentado: `422 UNSUPPORTED_FILTER_COMBINATION`;
- dados parciais: `200` com `meta.partial`, `freshness` e `warnings`.

## Frontend

A tela Eventos funciona em dois modos:

- sem `incidente`: feed global, com filtro visível `Todos`, `Com incidente` e `Sem incidente`;
- com `incidente`: apenas Eventos correlacionados ao Incidente.

O estado inicial não aplica dispositivo, região, versão ou fonte fictícios. As opções de filtro vêm
dos facets reais. A paginação oferece carregar a próxima página sem perder os itens já exibidos.

A tela Evidências continua vinculada a um Incidente e apresenta as Evidências reais mesmo quando
nenhuma hipótese estiver disponível. A interface mostra origem, regra de correlação, horário,
qualidade e ligação para o Evento.

Fixtures permanecem permitidas somente quando `NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` em
desenvolvimento ou teste. Produção continua forçando essa opção para `false`.

## Qualidade e freshness

Cada resposta deriva qualidade dos fatos usados:

- `measured`: cobertura completa e sem flags relevantes;
- `partial`: cobertura incompleta ou flags de origem;
- `delayed`: `observedThrough` ultrapassa o limite de atraso do endpoint;
- `unavailable`: projeção ou bruto solicitado indisponível.

O feed informa `observedThrough`, `lagSeconds`, dataset de origem e warnings. Nenhum campo ausente
é convertido em zero, texto plausível ou timestamp inventado.

Quando uma origem esparsa excede o limite de intervalos exatos do manifesto, os registros e os
arquivos canônicos continuam integrais. Somente o resumo de disponibilidade é reduzido ao envelope
temporal e recebe `SPARSE_INTERVALS_COMPACTED`; a cobertura publicada passa a `PARTIAL`, evitando
apresentar o envelope resumido como cobertura contínua medida.

## Paginação

O cursor é assinado e contém somente estado necessário: `datasetVersion`, direção, último dia,
última chave de ordenação e fingerprint dos filtros. Ele não expõe chaves físicas diretamente.

A API lê partições diárias na ordem pedida, aplica os filtros suportados e continua entre dias até
preencher o limite ou esgotar a janela. A troca do dataset ativo invalida cursores anteriores.

## Testes e validação

O desenvolvimento segue RED-GREEN-REFACTOR.

Cobertura mínima:

- unidade: identidade de Evento, mapeamento dos três datasets, timestamp ausente, preservação de
  dimensões/medidas, regra temporal e semântica, não correlação e força da Evidência;
- contrato: payloads fechados, OpenAPI, cursor, erros, qualidade e campos de rastreabilidade;
- integração: canônico -> projeções DynamoDB -> API para feed global, Incidente e diagnóstico;
- frontend: modo global, modo Incidente, filtro de não correlacionados, paginação e estados
  partial/unavailable;
- dump recente: contagens reconciliadas por dataset, amostra de IDs determinísticos, nenhum Evento
  elegível descartado e nenhuma Evidência sem correlação persistida;
- E2E: Incidentes -> Eventos -> detalhe e Incidentes -> Evidências.

Fixtures e seeds são somente insumos de testes. A prova de produção usa a versão ativa derivada do
dump ARGUS.

## Operação e segurança

- qualquer comando AWS usa apenas `--profile default --region us-east-1`;
- o trabalho não executa `terraform destroy`;
- nenhuma atualização Terraform ocorre antes de os commits serem integrados ao checkout original
  limpo;
- dimensões e medidas públicas passam pela sanitização existente e não expõem PII;
- payload bruto só é devolvido quando estiver materializado, permitido e sanitizado; caso contrário,
  o contrato explica a indisponibilidade.

## Critérios de aceite

1. As três fontes elegíveis produzem Eventos reais e pesquisáveis.
2. O total projetado é reconciliado com o total canônico elegível, incluindo Eventos sem Incidente.
3. Nenhuma Evidência existe sem `eventId`, `incidentId`, `ruleVersion` e detalhes da correspondência.
4. A janela é configurável e nunca supera cinco horas para `argus-explicit-v2`.
5. Feed global e consultas por Incidente possuem paginação estável e filtros declarados.
6. API e frontend exibem qualidade, freshness, origem e disponibilidade do bruto.
7. Produção não depende de fixture ou seed.
8. Testes unitários, de contrato, integração e E2E passam no worktree.
9. A validação com dump recente registra contagens e amostras rastreáveis.

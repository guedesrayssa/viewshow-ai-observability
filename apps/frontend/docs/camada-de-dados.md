# Camada de dados

Todas as telas falam apenas com o gateway configurado por
`NEXT_PUBLIC_API_BASE_URL`:

```text
view -> useResource -> *-resource -> client -> gateway /api/v1
                                      |
                                      +-> { data, meta } ou { error }
```

`client.ts` usa timeout de oito segundos, `cache: no-store` e
`credentials: include`. O envelope público fornece `requestId`, versão,
partialidade, freshness, warnings, janela resolvida e `refreshAfterSeconds`.
Esses campos acompanham o `Resource<T>`; valores ausentes não viram zero.

`availability` pode ser `measured`, `partial` ou `unavailable`. Erros HTTP
preservam status, code e requestId. Quando não há configuração ou uma leitura
falha, o resource devolve indisponibilidade, não dado plausível.

Fixtures dos arquivos `*-data.ts` só entram quando
`NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` em desenvolvimento/teste. O modo é
forçado para `false` em produção.

## Endpoints consumidos

| Tela          | Endpoint                                                        |
| ------------- | --------------------------------------------------------------- |
| Visão Geral   | `GET /api/v1/dashboard/overview`                                |
| Incidentes    | `GET /api/v1/incidents`                                         |
| Evidências    | `GET /api/v1/incidents/{id}/diagnosis`                          |
| Revisão       | `PATCH /api/v1/incidents/{id}/hypotheses/{hypothesisId}/review` |
| Eventos       | `GET /api/v1/events` ou `GET /api/v1/incidents/{id}/events`     |
| Monitoramento | `GET /api/v1/monitoring/overview`                               |

Sem `incidentId`, Eventos usa o feed global paginado e mostra também os itens
não correlacionados. Com `incidentId`, consulta somente os eventos ligados ao
incidente. Os filtros enviados são período, busca, categoria, dataset de origem
e estado de correlação; o cursor opaco recebido da API abre a página seguinte.

Eventos e Evidências nunca usam fallback de exemplo, mesmo no modo de
demonstração. Cada Evento preserva dataset, identificador do registro,
localizador canônico, timestamp, dimensões, medidas, qualidade, freshness e a
disponibilidade do bruto. Evidências vêm exclusivamente da correlação explícita
publicada no diagnóstico do incidente, incluindo regra, distância temporal e
campos que coincidiram. A revisão utiliza a versão recebida no diagnóstico e
trata 409.

Os mapeadores copiam somente campos públicos; chaves DynamoDB não fazem parte
dos tipos de resposta. Testes em `tests/` cobrem measured/partial/unavailable,
erros com requestId, mapeadores, revisão otimista, flag de fixtures e busca
estática por referências retiradas.

## Importações ARGUS

O fluxo de `/dados/importacoes` usa um cliente e um provider dedicados:

```text
ImportsView -> useImportUpload -> ImportUploadProvider -> ImportClient
                                      |                    |
                                      |                    +-> fetch autenticado /api/v1/imports
                                      +-> XHR PUT direto para URL assinada do S3
```

`ImportClient` usa `apiRequest`, portanto as chamadas ao gateway preservam
`credentials: include`, timeout/abort, envelope e `requestId`. O PUT de cada
parte usa `XMLHttpRequest` diretamente contra a URL assinada, sem cookie
(`withCredentials=false`), para obter progresso de bytes e o `ETag`. Cabeçalhos
assinados, inclusive `x-amz-checksum-sha256`, são enviados sem alteração.

### Oito operações do contrato

| Método e rota                             | Cliente                  | Acesso                                                          |
| ----------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `GET /api/v1/imports?limit=&cursor=`      | `ImportClient.list`      | Qualquer autenticado; histórico compartilhado com cursor opaco. |
| `POST /api/v1/imports`                    | `ImportClient.start`     | Qualquer autenticado; cria a única importação global ativa.     |
| `GET /api/v1/imports/:importId`           | `ImportClient.get`       | Qualquer autenticado; estado durável compartilhado.             |
| `GET /api/v1/imports/:importId/parts`     | `ImportClient.listParts` | Somente autor; partes confirmadas para retomada.                |
| `POST /api/v1/imports/:importId/parts`    | `ImportClient.signParts` | Somente autor; assina de 1 a 20 partes.                         |
| `POST /api/v1/imports/:importId/restart`  | `ImportClient.restart`   | Somente autor; substitui multipart divergente.                  |
| `POST /api/v1/imports/:importId/complete` | `ImportClient.complete`  | Somente autor; fecha o upload com ETags e checksums.            |
| `POST /api/v1/imports/:importId/activate` | `ImportClient.activate`  | Qualquer autenticado; ativa um candidato `READY`.               |

`POST` de início, reinício, conclusão e ativação envia `Idempotency-Key`; assinatura
de partes não usa essa chave. O autor é definido pela sessão e chega ao
frontend como `canManageUpload`; nome e e-mail não são usados como decisão de
autorização. Uma segunda tentativa de criação recebe
`409 IMPORT_IN_PROGRESS` e o `importId` ativo.

### Arquivo, multipart e retomada

O corpo inicial contém `fileName`, `sizeBytes` e `snapshotExtractedOn`. A data é
civil (`YYYY-MM-DD`) e descreve quando o dump foi extraído na origem, não
quando foi enviado. Os formatos aceitos são `argus_dump.sql.gz`, de até 5 GiB,
ou um `.zip`, de até 10 GiB, com exatamente um membro regular, não
criptografado, na raiz e chamado `argus_dump.sql.gz`. O GZIP interno permanece
limitado a 5 GiB, a expansão ZIP a 100:1 e o SQL descompactado a 100 GiB. Esse
último valor é um limite de validação, não uma promessa de capacidade física
do worker.

`multipart-upload.ts` divide o arquivo em partes de 16 MiB, exceto a final, e
mantém no máximo três leituras/PUTs simultâneos. Calcula SHA-256 em base64 sobre
os mesmos bytes enviados, pede URLs em janelas de até 20 partes e só conclui
quando cada parte possui ETag e checksum. URLs assinadas expiram em 15 minutos;
o registro em `UPLOADING` expira em 24 horas e `PREPARING` preso expira em 5
minutos.

Na retomada, `listParts` fornece a evidência durável. Nome e tamanho do arquivo
selecionado precisam coincidir; o cliente recalcula os checksums das partes
existentes, reaproveita as iguais e chama `restart` diante de evidência
divergente. A API nunca expõe upload ID ao frontend. `File`, URLs, cabeçalhos
assinados, checksums e ETags permanecem somente em memória durante a operação:
não entram em `localStorage`/`sessionStorage`, logs ou snapshots.

### Provider, polling e progresso

`ImportUploadProvider` fica no layout autenticado, acima das páginas. Trocar
de rota dentro do painel preserva a referência ao `File`, o `AbortController`,
o progresso e o PUT em andamento. Fechar ou recarregar a aba desmonta esse
estado e interrompe bytes locais; não existe garantia de transferência em
segundo plano. Ao reabrir durante `UPLOADING`, o provider relê o backend e
expõe `needsFileReselection=true` somente ao autor. Depois de `UPLOADED`, o
backend continua sem depender do browser.

Enquanto existe estado não terminal, o provider consulta o detalhe a cada 5
segundos. O polling pausa com `document.visibilityState === "hidden"`, evita
requisições sobrepostas e atualiza imediatamente quando a aba volta a ficar
visível. A listagem usa cursor e anexa páginas sem substituir snapshots mais
novos por respostas atrasadas.

`ImportProgress` é uma união discriminada:

- `{kind: "bytes", completedBytes, totalBytes}` em `UPLOADING`; o provider
  combina bytes duráveis confirmados com bytes locais em voo para a exibição;
- `{kind: "stage", stage, recordsRead, recordsWritten, recordsRejected}` em
  processamento;
- `{kind: "none"}` quando ainda não existe progresso mensurável.

Os sete estados são `PREPARING`, `UPLOADING`, `UPLOADED`, `VALIDATING`,
`PROCESSING`, `READY` e `FAILED`. Somente bytes têm percentual conhecido;
validação e processamento mostram etapa e contadores reais, sem estimativa
artificial. `FAILED` preserva mensagem segura e `requestId`. `READY` expõe uma
`candidateVersion`, mas não significa `ACTIVE`. O histórico mostra uma versão
curta, oferece a ativação a qualquer sessão autenticada e exige confirmação
explícita de que a troca alimentará todos os painéis. A listagem retorna
`activeDatasetVersion` para identificar o dataset ativo sem inferência local.

Para troubleshooting, correlacione somente `importId` e `requestId`. Não peça
nem registre URL assinada, upload ID, credencial, cabeçalho, ETag, checksum ou
conteúdo do dump.

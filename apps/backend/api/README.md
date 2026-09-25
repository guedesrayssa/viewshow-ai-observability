# API (monólito modular)

Única entrada pública do painel. Expõe `/health`, `/metrics`,
`GET /auth/session`, `GET /auth/login`, `GET /auth/callback`,
`POST /auth/logout` e `/api/v1/*`; valida a borda, aplica CORS/headers/rate
limit e propaga request e trace context.

Um único processo Express. A lógica de domínio vive em módulos internos sob
`src/modules/` (`auth`, `imports`, `incidents`, `dashboard`), cada um com suas camadas
`application` / `adapters` / `ports` / `domain`. Os módulos são chamados em
processo — não há servidores HTTP internos nem supervisor.

```bash
npm run build
set -a
. ./.env
set +a
npm start
```

`DYNAMODB_ENDPOINT` é opcional e direciona os adaptadores ao DynamoDB Local.
O processo exige, além da sessão e da tabela operacional, os oito valores
`IMPORT_BUCKET`, `IMPORT_EXPECTED_BUCKET_OWNER`, `IMPORT_CURSOR_SECRET`,
`IMPORT_INGESTION_CLUSTER_ARN`, `IMPORT_INGESTION_TASK_DEFINITION_ARN`,
`IMPORT_INGESTION_SUBNET_IDS`, `IMPORT_INGESTION_SECURITY_GROUP_ID` e
`IMPORT_INGESTION_CONTAINER_NAME`. Use [`.env.example`](.env.example) como
inventário; no deployment, `IMPORT_CURSOR_SECRET` reutiliza o valor de
`CURSOR_SECRET`.

O teste vivo completo pode ser executado sem credenciais AWS reais:

```bash
npm run test:e2e-local
```

O comando inicia o container local, injeta credenciais dummy e executa build e
requisições HTTP reais. Em ambiente que já oferece o serviço, configure
`DYNAMODB_ENDPOINT` e execute `npm run test:e2e`.

O contrato de autenticação é federado e usa sessão assinada. Cognito/OIDC ainda
não tem adaptador operacional: login e callback falham fechado com
`503 FEATURE_UNAVAILABLE`; sessão ausente falha com `401 UNAUTHENTICATED` e
logout apenas expira o cookie. A reanálise também é validada, porém a
publicação na SQS continua indisponível e responde
`503 FEATURE_UNAVAILABLE` após autenticação válida, sem simulação ou fallback.

## Controle live do ARGUS

`GET` e `PATCH /api/v1/integrations/argus` exigem sessão autenticada. O botão em
**Configurações** usa esse endpoint e controla sync e reprocess para qualquer
usuário autenticado. O estado live do ARGUS fica em `CONTROL#ARGUS`/`LIVE_SYNC`
na tabela operacional, que é a fonte autoritativa; item ausente equivale a
desligado.

Com a integração desligada, o worker bloqueia novas leituras e o agendador
pausa novos disparos, mas uma task já iniciada não é cancelada. Operadores devem
habilitar a integração pelo endpoint autenticado (ou pelo botão em
**Configurações**) antes de invocar um comando live. As credenciais continuam
no Secrets Manager e nunca são retornadas por esse endpoint.

No Learner Lab, a task usa a `LabRole` preexistente: o AWS Academy bloqueia a
anexação de policies e, portanto, a operação pressupõe que essa role permita as
ações DynamoDB/Scheduler necessárias. Em produção, `api_task_role_arn` é
obrigatória e o Terraform anexa a ela uma policy exclusiva com `GetItem` e
`PutItem` na tabela operacional, `GetSchedule` e `UpdateSchedule` no schedule da
ingestão e `PassRole` somente para a role-alvo do Scheduler com
`iam:PassedToService=scheduler.amazonaws.com`.

Não execute um `terraform apply` que recrie ou altere o schedule ao mesmo tempo
que um `PATCH`: serialize as duas mudanças. O Terraform ignora apenas `state`
no recurso existente, mas uma recriação volta a usar a seed do deploy antes de
o próximo `PATCH` convergir o estado operacional.

## Importação assíncrona ARGUS

Qualquer usuário autenticado pode iniciar uma importação e ler o histórico
compartilhado. Existe no máximo uma importação não terminal globalmente; uma
segunda criação recebe `409 IMPORT_IN_PROGRESS` com o `importId` em curso.
Somente o autor, indicado por `requestedBy` derivado da sessão, pode listar ou
assinar partes, reiniciar o multipart e concluí-lo. O cliente nunca envia
`requestedBy`.

São aceitos exatamente:

- `argus_dump.sql.gz`, com até 5 GiB;
- um arquivo `.zip`, com até 10 GiB, contendo exatamente um membro regular,
  não criptografado, na raiz e chamado `argus_dump.sql.gz`;
- o GZIP interno do ZIP continua limitado a 5 GiB, a expansão do ZIP a 100:1
  e o SQL descompactado a 100 GiB.

`snapshotExtractedOn` é obrigatório no formato `YYYY-MM-DD` e representa a
data civil de origem do dump, não a data do envio. O limite de 100 GiB valida o
conteúdo lógico e não garante capacidade física para materializá-lo em qualquer
ambiente.

### Rotas

Todas as sete operações exigem sessão autenticada:

| Operação                                  | Acesso e finalidade                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/v1/imports?limit=&cursor=`      | Leitura compartilhada, paginada por cursor opaco.                                                    |
| `POST /api/v1/imports`                    | Reserva a trava global e inicia o multipart. Recebe `fileName`, `sizeBytes` e `snapshotExtractedOn`. |
| `GET /api/v1/imports/:importId`           | Leitura compartilhada do estado durável.                                                             |
| `GET /api/v1/imports/:importId/parts`     | Somente autor; obtém as partes confirmadas para retomada.                                            |
| `POST /api/v1/imports/:importId/parts`    | Somente autor; assina de 1 a 20 partes por chamada.                                                  |
| `POST /api/v1/imports/:importId/restart`  | Somente autor; troca o multipart da mesma importação após divergência.                               |
| `POST /api/v1/imports/:importId/complete` | Somente autor; valida a evidência do S3 e conclui o upload.                                          |

`POST /api/v1/imports`, `POST .../restart` e `POST .../complete` exigem
`Idempotency-Key` não vazio, com até 128 caracteres. As partes têm 16 MiB,
exceto a final, carregam SHA-256 e são assinadas em lotes de no máximo 20. As
URLs pré-assinadas expiram em 15 minutos. A API não expõe bucket, chave física,
upload ID ou ARN da task nas respostas normais.

### Estados, progresso e expiração

O fluxo durável possui sete estados:

- `PREPARING`: registro e trava criados enquanto o multipart é preparado;
- `UPLOADING`: transferência direta ao S3, com bytes confirmados/total;
- `UPLOADED`: multipart concluído e aguardando o worker;
- `VALIDATING`: validação de formato, integridade e contrato ARGUS;
- `PROCESSING`: backfill em andamento, com etapa e contadores reais;
- `READY`: candidato validado e disponível para revisão;
- `FAILED`: falha terminal com código, mensagem segura e `requestId`.

Somente o upload possui percentual, pois seu total de bytes é conhecido. A
validação e o processamento expõem etapa e, quando disponíveis,
`recordsRead`, `recordsWritten` e `recordsRejected`, sem percentual inventado.
Um `PREPARING` preso expira após 5 minutos; um `UPLOADING` expira após 24
horas. O reconciliador inicia com o processo da API, executa uma passagem
imediata e depois a cada 60 segundos, com lease de 45 segundos. Não existe
comando manual, Scheduler ou Lambda para esse loop.

O navegador consegue manter a transferência enquanto a pessoa navega entre
rotas do painel porque o provider vive no layout autenticado. Fechar ou
recarregar o browser interrompe os bytes locais: não há promessa de upload em
segundo plano. Durante a janela de 24 horas, o autor pode selecionar novamente
o mesmo arquivo; checksums iguais preservam partes válidas e qualquer
divergência reinicia o multipart.

O worker é disparado no container como
`python -m bootstrap import-dump --import-id <imp_ULID>`. Um resultado
bem-sucedido termina em `READY` e persiste `candidateVersion`, mas jamais
altera `CONTROL#DATASET/ACTIVE` automaticamente. Qualquer pessoa autenticada
pode confirmar `POST /api/v1/imports/:importId/activate` para promover um
candidato `READY`. A troca usa compare-and-swap, grava a cerca de projeções, a
evidência de idempotência e a auditoria na mesma transação DynamoDB.

### Diagnóstico

Correlacione suporte e logs pelo `importId` e pelo `requestId` do envelope ou
do erro seguro. Verifique primeiro o estado, a expiração e a etapa persistida;
`UPLOAD_EXPIRED`, `UPLOAD_PREPARATION_FAILED` e `WORKER_STOPPED` distinguem os
principais caminhos operacionais. Nunca solicite ou registre URL pré-assinada,
upload ID, credencial, chave física ou conteúdo do dump.

Contrato público: [`contracts/openapi/public.openapi.json`](contracts/openapi/public.openapi.json).

Testes de carga (k6): [`loadtest/README.md`](loadtest/README.md).

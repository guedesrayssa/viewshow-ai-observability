# Frontend do View Show

Painel estático em Next.js 16, React 19, TypeScript e Tailwind CSS v4. Layout,
componentes, textos, tokens, assets e responsividade são preservados; a camada
de resources adapta o contrato público do gateway aos tipos das telas.

## Execução

```bash
npm ci
npm run dev -- -p 3004
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Copie `.env.example` para `.env.local` e configure uma única API:

| Variável                         | Uso                                                                         |
| -------------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL`       | Base pública do gateway; `/` significa mesma origem no Amplify.             |
| `NEXT_PUBLIC_ALLOW_EXAMPLE_DATA` | Fixtures somente por opt-in em desenvolvimento/teste; ignorada em produção. |

Sem gateway ou dado real, a interface usa seus estados existentes de parcial
ou indisponível. A autenticação nunca declara sessão de demonstração sem a flag
explícita e não guarda token em `localStorage`.

## Controle live do ARGUS

Em **Configurações**, qualquer usuário autenticado pode usar o botão de
sincronização do ARGUS para controlar sync e reprocess pela plataforma
autenticada (`GET`/`PATCH /api/v1/integrations/argus`). O estado autoritativo
fica no item `CONTROL#ARGUS`/`LIVE_SYNC` da tabela operacional; item ausente
equivale a desligado.

Desligar bloqueia novas leituras e pausa novos disparos, mas não cancela uma
task já iniciada. Antes de executar um comando live, habilite a integração pela
plataforma autenticada. As credenciais continuam no Secrets Manager e não são
expostas ao frontend.

## Camada de integração

- `lib/data/client.ts`: envelope `{data,meta}`, erros com requestId, timeout,
  warnings, freshness, partialidade e refresh hint.
- `lib/data/endpoints.ts`: somente `/api/v1/*` e `/auth/*` públicos.
- `app/(painel)/*/*-resource.ts`: adaptadores DTO → tipos visuais.
- `hooks/use-resource.ts`: loading, ready, refresh e indisponibilidade.

Eventos exigem `?incidente=<id>` explícito. Revisão humana envia o ID de
hipótese e `expectedVersion` e mostra conflito 409.

## Rotas

`/login`, `/criar-conta`, `/recuperar-senha`, `/visao-geral`, `/incidentes`,
`/evidencias`, `/eventos`, `/monitoramento`, `/dados/importacoes`,
`/configuracoes` e `/design-system`.

## Dados e importações

A página protegida `/dados/importacoes` inicia e acompanha a importação
assíncrona de dumps ARGUS. Qualquer usuário autenticado pode reservar a única
vaga global e ler o histórico compartilhado; somente o autor recebe
`canManageUpload=true` e pode enviar, retomar, reiniciar ou concluir o multipart.
A autorização visual usa esse campo do contrato, nunca nome ou e-mail.

O modal exige confirmação e uma “Data de extração do dump”. O valor enviado
como `snapshotExtractedOn` é a data civil de origem em `YYYY-MM-DD`, não a data
do upload. Os formatos e limites exibidos são:

- `argus_dump.sql.gz`, com até 5 GiB;
- `.zip`, com até 10 GiB, contendo exatamente um membro regular, não
  criptografado, na raiz e chamado `argus_dump.sql.gz`;
- GZIP interno com até 5 GiB, expansão ZIP de no máximo 100:1 e SQL
  descompactado de até 100 GiB.

O teto de 100 GiB é um limite de validação do conteúdo, não promessa de
capacidade física do ambiente. O upload usa partes de 16 MiB, exceto a final,
SHA-256 por parte, no máximo três PUTs simultâneos no browser e lotes de
assinatura de até 20 partes. As URLs assinadas expiram em 15 minutos; a
importação em `UPLOADING` expira em 24 horas e uma preparação presa expira em
5 minutos.

O `ImportUploadProvider` envolve o `AppShell` no layout autenticado. Por isso,
navegar entre rotas do painel não desmonta o provider nem cancela o PUT em
andamento. Fechar ou recarregar a aba encerra as requisições locais e perde a
referência ao `File`: o browser não garante continuidade automática dos bytes.
Durante as 24 horas, o autor pode selecionar novamente o mesmo arquivo; nome e
tamanho precisam coincidir, partes existentes são revalidadas por checksum e
uma divergência reinicia o multipart. Depois de `UPLOADED`, validação e
processamento continuam no backend sem depender da aba.

A interface representa os sete estados duráveis:

- `PREPARING`: multipart em preparação;
- `UPLOADING`: bytes confirmados mais bytes em voo sobre o total;
- `UPLOADED`: upload completo, aguardando worker;
- `VALIDATING`: validação do arquivo e do contrato ARGUS;
- `PROCESSING`: backfill por etapa, com contadores reais;
- `READY`: candidato validado, ainda não ativo;
- `FAILED`: falha terminal com mensagem segura e `requestId`.

Somente o upload mostra percentual. `VALIDATING` e `PROCESSING` usam etapa e
`recordsRead`/`recordsWritten`/`recordsRejected`, sem percentual sem
denominador. O estado ativo é consultado a cada 5 segundos enquanto a aba está
visível; o polling pausa em segundo plano e atualiza imediatamente quando a
visibilidade volta.

As sete operações do gateway — listar, iniciar, obter, listar partes, assinar
partes, reiniciar e concluir — estão detalhadas em
[camada de dados](docs/camada-de-dados.md). Início, reinício e conclusão usam
`Idempotency-Key`. Para suporte, registre somente `importId` e `requestId`;
nunca URL assinada, upload ID, credencial, ETag, checksum ou conteúdo do dump.

`READY` significa apenas que existe uma `candidateVersion`. A tela não oferece
seleção ou ativação e a importação jamais troca o dataset ativo.

Leia [camada de dados](docs/camada-de-dados.md),
[deploy integrado](docs/deploy-aws-integrado.md) e
[design system](docs/design-system.md).

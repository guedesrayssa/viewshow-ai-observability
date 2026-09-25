# Infraestrutura fullstack

Este diretório centraliza a infraestrutura como código do View Show:

- Terraform da stack AWS atualmente implementada — VPC dedicada, API TypeScript
  privada em ECS/Fargate com autoescalonamento, ALB, bastion, Flow Logs,
  frontend no Amplify, tarefas ECS privadas de ingestão, data lake S3,
  Glue/Athena, filas/Scheduler e duas tabelas DynamoDB compartilhadas;
- Docker Compose e configurações da observabilidade local ou, mediante opt-in,
  em uma EC2 isolada na AWS;
- scripts auxiliares de publicação usados pelo Terraform.

O Cognito entrou nesta stack (`cognito.tf`) para sustentar o login por usuário e
senha (`POST /auth/login`, fluxo `USER_PASSWORD_AUTH`). Ingestão, data lake, filas
e workers usam as tarefas Terraform descritas nesta stack; o runtime é o pacote
Python em `apps/backend/ingestion-data`. As tasks compartilham a VPC dedicada da
API, usam apenas as subnets privadas e saem pelo NAT/endpoints, sem IP público.
Os nomes físicos derivam de `deployment_namespace=view-show`, e a tabela operacional
`view-show-operacional` continua compartilhada com os GSIs `trace-index` e
`outbox-pending-index`. O contrato federado (`GET /auth/login`, `/auth/callback`)
permanece fail-closed até existir um provedor corporativo real. O build de produção
do painel nunca habilita dados de exemplo: falhas das APIs permanecem visíveis como
estados vazios, parciais ou indisponíveis.

O artefato de entrega sobre arquitetura, configuração e operação está em
[`artefatos/sprint3/infraestrutura-integracao.md`](../../artefatos/sprint3/infraestrutura-integracao.md).
Para as stacks LGTM local e AWS, consulte também
[`observability/README.md`](observability/README.md).

## Validação local

Pré-requisitos: Terraform `>=1.7,<2.0`, Docker ativo, Node.js 22, npm, AWS CLI v2,
uma sessão válida do AWS Academy e a key pair `vockey` em `us-east-1`. O comando
usa o profile `default`, salvo quando `--profile` é informado. Confirme a conta:

```bash
aws sts get-caller-identity --profile default --region us-east-1
```

O provider usa a cadeia padrão de credenciais da AWS. Não há variável
`aws_account_id`; `deployment_namespace=view-show` e `regiao=us-east-1` já são os
padrões validados. Da raiz do repositório, execute:

```bash
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack validate
npm --prefix apps/backend/api run test:ci-policy
```

## Planejamento e aplicação

Para o Learner Lab, o caminho recomendado é o setup multiplataforma executado na
raiz do repositório:

```bash
node scripts/aws-learner-lab.mjs setup
```

No início, o comando solicita o e-mail e a senha do usuário inicial; a senha é
lida sem eco e não é colocada em argumentos, logs ou state. Em seguida ele valida
versões, identidade, `vockey`, workspace `default` e o perfil econômico do
Learner Lab; salva e valida o plano; mostra o resumo operacional; pede apenas uma
confirmação `s/N`; aplica a stack completa; cria ou atualiza o usuário no Cognito;
confirma o status `CONFIRMED`; e imprime as URLs e identificadores não sensíveis.
Após o apply, `setup`, `deploy` e `update` garantem que a credencial interna do
MySQL temporário de ingestão tenha uma versão `AWSCURRENT`: ela é gerada
aleatoriamente apenas quando ausente, enviada ao Secrets Manager por arquivo
temporário com permissões restritas e nunca é impressa, passada em argumentos ou
gravada no state.
Para outro profile use `--profile <nome>`. Em automação deliberada, `--yes` pula
somente a confirmação do deploy — os prompts e todas as validações permanecem.
O profile `nora` é recusado. Overrides ocultos por ambiente ou arquivos
automáticos `.tfvars` também são recusados. O Scheduler nasce
`DISABLED` e o item `CONTROL#ARGUS`/`LIVE_SYNC` ausente bloqueia leituras; o
controle autenticado pode convergir ambos depois do deploy. Bedrock, SSH e a
EC2 opcional de observabilidade permanecem desabilitados. Use os comandos
abaixo somente para diagnóstico ou operação avançada.

`setup` e `deploy` permanecem exclusivamente create-only: eles nunca atualizam uma stack
existente e continuam passando pelo gate `validate-terraform-create-plan.mjs`.
Para republicar somente os artefatos stateless allowlisted de uma stack já
existente, integre primeiro os commits no checkout original que possui o state,
deixe esse checkout limpo e use um dos presets fechados:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs plan-update phase2-10000
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase2-10000
```

Os presets aceitos são `baseline`, `phase1-2000`, `phase1-5000`,
`phase1-10000`, `phase2-2000`, `phase2-5000` e `phase2-10000`; não há
passthrough de flags Terraform. `baseline` restaura
`MYSQL_SNAPSHOT_PREPARE_ENABLED=false`, `PAGE_SIZE=500` e canonical-first
desligado. Todos os presets `phase1-*` mantêm o preflight ligado e reservam
`legacy-v1` somente para imports novos. Os presets `phase2-*` usam o mesmo page
size do sufixo, ligam canonical-first somente para imports novos e mantêm
`IMPORT_HOT_MATERIALIZATION_ENABLED=false`. Voltar de `phase2-10000` para
`phase1-10000` muda somente essa reserva futura: lifecycle, capacidade e
alarmes continuam presentes, sem delete de storage.

O caminho de update exige caller `assumed-role/voclabs`, credencial ativa,
workspace `default`, profile `default`, região `us-east-1`, state regular do
usuário e a confirmação exata `UPDATE view-show <account-id> <preset>`. Ele compara
lineage/serial local e remoto, valida o owner do bucket, recusa import ativo
tanto antes do plano quanto imediatamente antes do apply,
salva backup `0600` sob `.terraform-artifacts/state-backups/`, aplica exatamente
o plan validado e repete as verificações. State, JSON do plan e credenciais nunca
são gravados em `.artifacts` nem impressos. Não copie nem crie symlink para o
state em worktrees.

O Learner Lab reutiliza a `LabRole`, pois o AWS Academy bloqueia anexação de
policy; antes de habilitar o live, confirme operacionalmente que essa role
permite as ações requeridas. Em `ambiente=production`, forneça
`api_task_role_arn`: o Terraform exige o ARN e anexa as policies mínimas da
importação e do controle ARGUS. A identidade que aplica o plano precisa poder executar
`iam:PutRolePolicy` nessa role; uma recusa interrompe o deploy em vez de deixar
a API sem o contrato silenciosamente.

Serialize mudanças de infraestrutura e de estado: não execute `terraform
apply` que recrie o schedule em paralelo a um `PATCH` do controle. O atributo
`state` é ignorado no recurso existente, mas uma recriação usa novamente a seed
`scheduler_ingestao_habilitado` até a aplicação convergir o estado.

Salve o plano dentro do diretório ignorado `.terraform-artifacts`, valide seu
JSON no gate de create/no-op e aplique exatamente o mesmo arquivo:

```bash
mkdir -p apps/fullstack/.terraform-artifacts
chmod 700 apps/fullstack/.terraform-artifacts
umask 077
terraform -chdir=apps/fullstack plan \
  -input=false \
  -out=.terraform-artifacts/view-show.tfplan
chmod 600 apps/fullstack/.terraform-artifacts/view-show.tfplan

# Forma geral: terraform show -json <saved plan> | node scripts/ci/validate-terraform-create-plan.mjs
terraform -chdir=apps/fullstack show -json \
  .terraform-artifacts/view-show.tfplan | \
  node scripts/ci/validate-terraform-create-plan.mjs

terraform -chdir=apps/fullstack apply \
  -input=false \
  .terraform-artifacts/view-show.tfplan
```

Os comandos `chmod` e `umask` acima são para Linux/macOS. No Windows, prefira a
CLI oficial e mantenha o worktree em uma pasta privada do usuário, pois o plano
herda a ACL do diretório.

Na pipeline do GitLab, a conta não vem do `.gitlab-ci.yml`: cada projeto define
`AWS_ACCOUNT_ID` como variável de CI/CD. Os scripts a exigem presente e
recusam a execução se a credencial em vigor pertencer a outra conta.

Só prossiga para um `apply` deliberado do plano salvo quando o gate aceitar o
JSON. Em criação ou reexecução idempotente, ele aceita exclusivamente os
endereços conhecidos com ação `create` ou `no-op`; qualquer update, delete,
substituição ou recurso inesperado é recusado. Durante o `apply`, scripts locais
publicam as imagens da API e da ingestão no ECR, o frontend no Amplify e criam os
buckets privados; mantenha Docker, Node.js e AWS CLI disponíveis.

O SSH no bastion fica desativado por padrão. Para uma gravação que exija SSH,
gere um novo plano com `-var='bastion_admin_cidr=<IP-PUBLICO>/32'`; a validação
rejeita `0.0.0.0/0`. O acesso recomendado continua sendo SSM.

O estado e os buckets legados pertencem a outra conta e não podem ser adotados
por esta stack.
Uma aplicação deliberada deve criar e preservar o novo estado local, necessário
para o teardown posterior dos recursos isolados.

### Importação assíncrona de dumps

O upload multipart usa o bucket privado da ingestão. O CORS permite somente
`PUT` e `HEAD` a partir da origem HTTPS exata do painel Amplify, aceita os
headers `content-type` e `x-amz-checksum-sha256` e expõe somente `ETag` e o
checksum. Em produção o provider gerencia essa regra; no Learner Lab o script de
compatibilidade reconcilia a mesma configuração sem tentar criar recursos IAM
proibidos pela SCP.

A API longa executa o reconciliador de importações e lança, sob demanda, a task
dedicada `ingestion-import` com override `import-dump --import-id <id>`. Não
existe Lambda ou schedule adicional para esse fluxo. Todas as cinco task
definitions de ingestão declaram 200 GiB de storage efêmero; o worker de
snapshot recebe orçamento da aplicação de 64 GiB, com teto configurável de 128
GiB, e sempre recebe
`ACTIVATE_CANDIDATE=false`. Sync e incremental preservam seus orçamentos de 8 e
16 GiB. Os alarmes `LocalDiskPeakBytes` disparam em 80%/90% dos 64 GiB, e
qualquer `ArchiveFailures` do componente `PARQUET` dispara o alarme de archive
canônico. Uma importação produz apenas um candidato.

Canonical-first nasce desligado. Em produção, habilitar
`import_canonical_first_enabled=true` exige também
`import_canonical_first_production_approved=true`; a API preserva `legacy-v1`
quando a flag está desligada e não reclassifica imports existentes. O lifecycle
adicional expira somente `staging/canonical/` após sete dias e aborta multipart
incompleto após um dia. Abort de multipart e remoção de delete markers também
ficam repetidos, com filtro explícito, somente em `raw/argus/incremental/`,
`dumps/`, `staging/` e no prefixo configurado de resultados Athena. Não existe
regra bucket-wide e nenhuma regra de lifecycle alcança `canonical/`, que contém
os objetos e o manifesto de commit imutáveis.

A task de snapshot tem 8 GiB, sidecar MySQL por digest e 200 GiB de storage
efêmero. O MySQL reserva 3 GiB ao buffer pool e 1 GiB ao redo, mantém
doublewrite/redo ativos, desliga binlog/performance schema e usa timeouts de rede
de dez minutos. O worker fixa timeouts de conexão/leitura/escrita/DDL e quatro
tentativas com backoff limitado. Senhas continuam exclusivamente no Secrets
Manager e não entram em variáveis ou state Terraform. Alterar buffer pool, redo,
page size ou flag registra uma nova task definition; isso vale apenas para novas
tasks e não recupera uma task que já falhou.

O perfil `production` exige `api_task_role_arn` e
`ecs_task_role_arn_importacao`, além das roles de ingestão já obrigatórias. A
role exclusiva de importação pode publicar candidatos sob
`CANDIDATE#DATASET#<versão>/MANIFEST`, mas denies explícitos impedem qualquer
operação em `CONTROL#DATASET`, exceto `GetItem`, inclusive quando outra policy
anexada concede `dynamodb:*`. Denies adicionais impedem mutações sem
`LeadingKeys`, fora da allowlist ou por ações alternativas/futuras; a API nega
explicitamente `RunTask` e `PassRole` fora da task e das duas roles do runtime.
Uma policy separada da API permite a ativação atômica somente em
`CONTROL#DATASET`, no candidato validado, na cerca de projeções e nos registros
de idempotência/auditoria; ela não amplia a role do worker.
Leituras da task também ficam limitadas aos namespaces do import/backfill mais
o `GetItem` do manifesto ativo: ledgers exclusivos da API, `Scan` e qualquer GSI
fora do `Query` exato em `outbox-pending-index` recebem explicit deny, inclusive
quando uma policy externa concede `dynamodb:*`.

As duas roles de produção são externas à stack. A governança deve garantir que
elas sejam dedicadas e não tenham permissões IAM para remover/alterar estas
inline policies, anexar novas policies, mudar permissions boundary/trust ou
assumir outra role. O valor `iam_isolation_enforced=true` indica que os denies
de runtime estão instalados; não transforma uma identidade administradora de
IAM em uma fronteira imutável.

No Learner Lab, a SCP obriga API, execution e tasks a reutilizarem `LabRole`;
portanto a task dedicada existe, mas a separação IAM não é garantida. O output
`ingestion_runbook.imports.iam_isolation_enforced` expõe `false` nesse perfil e
`true` em production. O restante do output contém somente identificadores,
capacidade e ARNs de alarmes, nunca o segredo de cursor nem URLs de upload.

Depois do `apply`, consulte os endpoints e as evidências principais:

```bash
terraform -chdir=apps/fullstack output -raw painel_url
terraform -chdir=apps/fullstack output -raw api_url_https
terraform -chdir=apps/fullstack output rede_vpc
terraform -chdir=apps/fullstack output bastion_acesso
terraform -chdir=apps/fullstack output ecs_auto_scaling
terraform -chdir=apps/fullstack output flow_logs
```

## Criar usuário do Cognito

Cada conta do Learner Lab cria um User Pool diferente. Execute estes comandos
na raiz do repositório depois do `terraform apply`; não copie IDs de outra
conta:

```bash
G05_COGNITO_POOL_ID="$(terraform -chdir=apps/fullstack output -raw cognito_user_pool_id)"
read -rp "E-mail: " G05_COGNITO_EMAIL
read -rsp "Senha: " G05_COGNITO_PASSWORD
echo

aws cognito-idp admin-create-user \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --user-attributes Name=email,Value="$G05_COGNITO_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region us-east-1

aws cognito-idp admin-set-user-password \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --password "$G05_COGNITO_PASSWORD" \
  --permanent \
  --region us-east-1

aws cognito-idp admin-get-user \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --region us-east-1 \
  --query UserStatus \
  --output text

unset G05_COGNITO_PASSWORD
```

O resultado final deve ser `CONFIRMED`. A senha precisa ter pelo menos oito
caracteres, com letra maiúscula, letra minúscula e número. Se o usuário já
existir, pule `admin-create-user` e execute os dois comandos seguintes.

# Infraestrutura e integração fullstack

Este módulo Terraform descreve a stack AWS que corresponde ao software
implementado hoje no repositório. A configuração é validável localmente e, nesta
branch, a stack foi aplicada na conta do Learner Lab indicada por `aws_account_id`
(na sessão atual, `904529597192`): os recursos existem na AWS e os endereços
saem em `terraform output` (`painel_url`, `api_url`, `api_url_https`).

## Escopo atual

| Componente | Responsabilidade | Arquivo |
|---|---|---|
| ECR | Repositório da imagem da API | `ecr.tf` |
| ECS Fargate | Cluster, task e serviço da API TypeScript | `ecs.tf` |
| CloudWatch Logs | Logs do container com retenção controlada | `ecs.tf` |
| ALB | Entrada HTTP e health check em `/health` | `alb.tf` |
| API Gateway | Terminação HTTPS para o proxy do Amplify | `apigateway.tf` |
| Amplify | Export estático do frontend e proxy same-origin | `amplify.tf` |
| DynamoDB | Tabelas operacional e golden set | `dynamodb.tf` |
| Cognito | User Pool, app client confidencial e domínio de prefixo para o login por senha | `cognito.tf` |

O módulo usa a VPC default e a `LabRole` disponíveis no AWS Academy. Ele também
contém automações locais para construir e publicar a imagem da API e o export
do frontend durante uma aplicação deliberada da stack.

O fluxo previsto é:

```text
navegador -> Amplify (HTTPS) -> API Gateway (HTTPS) -> ALB (HTTP)
                                                        -> ECS :3000
                                                           -> DynamoDB
```

O Cognito é provisionado por `cognito.tf`: um User Pool
(`aws_cognito_user_pool.principal`), um app client confidencial para o backend
(`aws_cognito_user_pool_client.backend`) e um domínio de prefixo
(`aws_cognito_user_pool_domain.principal`). Ele sustenta o login por usuário e
senha descrito abaixo. Não há Identity Pool, domínio custom no Hosted UI nem
gatilhos Lambda/SES — os limites estão comentados no próprio `cognito.tf`.

Esta infraestrutura não declara ingestion jobs, data lake, S3, Glue, Athena, SQS,
EventBridge ou workers de análise. Esses runtimes e adaptadores não estão
implementados no repositório e, portanto, não são apresentados como operacionais.

## Contrato do runtime

A task da API recebe porta, região, nomes das duas tabelas, origem do frontend, a
configuração opcional do Bedrock e as credenciais do Cognito
(`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` e `COGNITO_CLIENT_SECRET`), lidas
diretamente dos recursos de `cognito.tf` pelo bloco `environment` em `ecs.tf`. O
Terraform também gera dois valores criptográficos independentes de 64 caracteres:
um assina cookies de sessão e o outro assina cursores opacos de paginação. Esses
dois valores são enviados diretamente ao container, não são versionados e não são
publicados como outputs; o secret do app client sai apenas no output sensível
`cognito_client_secret`.

O runtime correspondente está em:

- `apps/backend/api/src/app.ts`, para rotas HTTP e atributos do cookie;
- `apps/backend/api/src/modules/auth/domain/session.ts`, para sessões assinadas;
- `apps/backend/api/src/modules/incidents/domain/cursor.ts`, para cursores;
- `apps/backend/api/src/modules/auth/adapters/configured-identity-provider.ts`,
  para a fronteira do provedor de identidade;
- `apps/backend/api/src/modules/auth/application/password-login-use-cases.ts` e
  `apps/backend/api/src/modules/auth/adapters/cognito-password-authenticator.ts`,
  para o login por usuário e senha contra o User Pool.

`POST /auth/login` autentica por usuário e senha diretamente contra o User Pool
do Cognito, pelo fluxo `USER_PASSWORD_AUTH` do `InitiateAuth`, feito no servidor
(sem SSO e sem Hosted UI). Em caso de sucesso, emite a mesma sessão HMAC assinada
das demais rotas e devolve o ID token no corpo; credencial inválida volta como
`401 UNAUTHENTICATED`. O app client é confidencial (`generate_secret = true`),
então cada `InitiateAuth` leva `SECRET_HASH`.

`GET /auth/login` e `GET /auth/callback` continuam representando o contrato
federado (OIDC) e retornam `503 FEATURE_UNAVAILABLE` enquanto não houver um
adaptador corporativo real. Isso é comportamento fail-closed: a ausência do
provedor federado não cria usuário nem sessão simulada.

As rotas de importação e reanálise seguem o mesmo princípio. Sem os adaptadores
de ingestão e publicação ainda não implementados, requisições autenticadas
recebem `503 FEATURE_UNAVAILABLE` em vez de jobs ou mensagens fictícias.

## Build e caminhos de origem

O contexto da imagem é `apps/backend/api`. O Dockerfile compila a API
TypeScript e seu pacote local `contracts`, e a imagem final executa
`dist/index.js`. O frontend é lido de `apps/frontend` e exportado estaticamente
para `out/`.

O export do Amplify é um build de produção e nunca habilita o conjunto local de
exemplos. Quando uma fonte não responde, o painel preserva o contrato
fail-closed e apresenta o estado vazio, parcial ou indisponível correspondente.

Os scripts auxiliares ficam em `apps/fullstack/scripts`:

| Script | Ação quando a stack é aplicada deliberadamente |
|---|---|
| `publicar-imagem.mjs` | Constrói a imagem `linux/amd64` e a envia ao ECR |
| `publicar-painel.mjs` | Envia o arquivo do export estático ao Amplify |

Nenhum desses scripts é executado por `terraform init` ou `terraform validate`.

## Pré-requisitos

Para validar localmente, instale Terraform 1.7 ou superior e Docker com o
plugin Compose. Para uma aplicação deliberada também são necessários Node.js
22 com `npm`, o daemon do Docker ativo, a AWS CLI e uma sessão válida do AWS
Academy. Selecione o profile temporário do laboratório por `AWS_PROFILE`; não
grave chaves em arquivos versionados.

O build do painel precisa de acesso a `fonts.googleapis.com`, pois
`next/font/google` baixa as fontes e as incorpora ao export estático.

## Validação local segura

Da raiz do repositório:

```bash
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack validate
docker compose -f apps/fullstack/docker-compose.observability.yml config --quiet
```

Essa sequência baixa os providers declarados quando necessário e valida
sintaxe, referências e configuração do Compose. Ela não consulta o estado da
stack, não cria recursos e não demonstra compatibilidade de permissões com uma
conta AWS específica.

A API compilada é validada separadamente contra DynamoDB Local:

```bash
cd apps/backend/api
npm run test:e2e-local
```

Esse teste sobe um DynamoDB Local fixado por digest, compila a API e exercita a
superfície HTTP real sem herdar credenciais ou profiles AWS.

## Estado local isolado e teardown

Esta entrega só aceita `deployment_namespace=g05-s3`. A conta AWS permitida vem
da variável obrigatória `aws_account_id`, que cada pessoa define em um
`terraform.tfvars` local não versionado (mesmo padrão do namespace). O estado
legado é de outra conta e não pode ser adotado por esta stack; copiar, importar
ou migrar esse estado faria o Terraform associar recursos fora do namespace
isolado.

Antes de qualquer mutação remota, inicialize o diretório e revise o plano. O
`aws_account_id` sai do `terraform.tfvars` local (carregado automaticamente); o
`deployment_namespace` continua obrigatório na linha de comando:

```bash
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack plan -out=g05-s3.tfplan \
  -var='deployment_namespace=g05-s3'
# Forma geral: terraform show -json <saved plan> | node scripts/ci/validate-terraform-create-plan.mjs
terraform show -json apps/fullstack/g05-s3.tfplan | node scripts/ci/validate-terraform-create-plan.mjs
terraform -chdir=apps/fullstack apply -input=false g05-s3.tfplan
```

O gate aceita somente o plano de criação isolado previsto para esta stack. Só
depois de ele aceitar o JSON é permitido aplicar exatamente esse mesmo plano
salvo, sem regenerá-lo entre o gate e o `apply`.

Uma aplicação deliberada cria um novo estado local em `apps/fullstack`. Esse
novo estado local é necessário para o teardown posterior: preserve-o até que a
remoção da stack isolada esteja concluída. Não o substitua por estado legado.

## Aplicação remota

A stack foi aplicada nesta branch com sessão do AWS Academy, Docker, Node.js e
Terraform. Antes de cada nova mutação remota, gere o plano salvo, passe-o pelo
gate local e revise as permissões da `LabRole`. Os recursos existem na conta do
Learner Lab; `terraform output` lê os endereços a partir do estado local. Uma
sessão encerrada do Learner Lab remove o acesso e `terraform plan` volta a
falhar com `AccessDenied` até a renovação das credenciais.

ALB, Fargate e API Gateway continuam gerando custo enquanto provisionados. A
stack e o estado devem ser preservados para inspeção e diagnóstico. Execute o
teardown somente após um pedido explícito posterior e usando o mesmo estado.

## Como encontrar o link do deploy

Depois de um `apply` deliberado, o output `painel_url` contém o endereço HTTPS
do painel. Ele pode ser consultado novamente, sem depender da saída do terminal
original, a partir do novo estado local isolado:

```bash
terraform -chdir=apps/fullstack output -raw painel_url
```

O output `api_url_https` mostra o endpoint HTTPS da API Gateway. Esses comandos
leem o estado local; não criam nem alteram recursos.

## Variáveis

| Variável | Padrão | Uso |
|---|---|---|
| `regiao` | `us-east-1` | Região permitida pelo Learner Lab |
| `deployment_namespace` | sem padrão; deve ser `g05-s3` | Origem obrigatória dos nomes isolados |
| `aws_account_id` | sem padrão; obrigatório | Conta AWS onde a stack pode ser aplicada; cada pessoa define em `terraform.tfvars` local |
| `branch_amplify` | `producao` | Branch hospedada no Amplify |
| `cpu_task` / `memoria_task` | `256` / `512` | Capacidade da task Fargate |
| `quantidade_tasks` | `1` | Réplicas do serviço |
| `bedrock_habilitado` | `false` | Explicação opcional via Bedrock |
| `retencao_logs_dias` | `7` | Retenção do log group |
| `observabilidade_habilitada` | `false` | Opt-in para Grafana, Prometheus, Loki, Tempo e Alloy em EC2 |
| `tipo_instancia_observabilidade` | `t3.medium` | Capacidade da EC2 opcional |
| `disco_observabilidade_gib` | `30` | Volume gp3 criptografado da observabilidade |
| `grafana_cidr_acesso` | `null` | Mantém o Grafana privado e acessível por túnel SSM |

Os nomes efetivos são derivados de `g05-s3`: ECR `g05-s3-api`, cluster ECS
`g05-s3-cluster`, serviço `g05-s3-api-service`, task family
`g05-s3-api-task`, container `g05-s3-api`, ALB `g05-s3-alb`, target group
`g05-s3-api-tg`, security group da API `g05-s3-api-sg`, Amplify
`g05-s3-painel`, tabelas `g05-s3-operacional` e `g05-s3-golden-set`.
Quando habilitada, a instância de observabilidade usa o nome
`g05-s3-observabilidade`; seu security group e a telemetria da API derivam do
mesmo namespace. A opção fica desligada por padrão para evitar custo acidental.

## Outputs não sensíveis

O módulo publica endereços, nomes de tabelas, URI da imagem, comandos de
operação e aviso de custo. Valores usados para assinatura de sessão e paginação
não aparecem em outputs. Quando a observabilidade é habilitada, a senha gerada
do Grafana aparece somente no output sensível `grafana_senha` e no state local.

## Troubleshooting

| Sintoma | Verificação |
|---|---|
| `Cannot pull container image` | Confirme que a publicação da imagem terminou e que a task usa a URI esperada |
| `exec format error` | Preserve o build da imagem para `linux/amd64` |
| Health check falha | Confirme a resposta exata `{"status":"ok"}` em `/health` e leia os logs do container |
| Painel abre sem dados | Verifique a saúde da API e a presença de itens nas tabelas; a IaC não inventa seed |
| `GET /auth/login` ou `/auth/callback` retorna 503 | Estado esperado: o contrato federado (OIDC) fica fail-closed até um adaptador corporativo real. Não afeta `POST /auth/login` |
| `POST /auth/login` retorna 503 `FEATURE_UNAVAILABLE` | A task não recebeu `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID`; confira o bloco `environment` em `ecs.tf` e reaplique |
| Importação ou reanálise retorna 503 | Estado esperado até os adaptadores correspondentes serem implementados |

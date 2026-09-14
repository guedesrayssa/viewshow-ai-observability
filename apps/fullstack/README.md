# Infraestrutura fullstack

Este diretório centraliza a infraestrutura como código do View Show:

- Terraform da stack AWS atualmente implementada — VPC dedicada, API TypeScript
  privada em ECS/Fargate com autoescalonamento, ALB, bastion, Flow Logs,
  frontend no Amplify e duas tabelas DynamoDB;
- Docker Compose e configurações da observabilidade local ou, mediante opt-in,
  em uma EC2 isolada na AWS;
- scripts auxiliares de publicação usados pelo Terraform.

O Cognito entrou nesta stack (`cognito.tf`) para sustentar o login por usuário e
senha (`POST /auth/login`, fluxo `USER_PASSWORD_AUTH`). Ingestão, data lake, filas
e workers seguem sem runtime no repositório e ficam fora da stack; o contrato
federado (`GET /auth/login`, `/auth/callback`) permanece fail-closed até existir
um provedor corporativo real. O build de produção do painel nunca habilita dados
de exemplo: falhas das APIs permanecem visíveis como estados vazios, parciais ou
indisponíveis.

O artefato de entrega sobre arquitetura, configuração e operação está em
[`artefatos/sprint3/infraestrutura-integracao.md`](../../artefatos/sprint3/infraestrutura-integracao.md).
Para as stacks LGTM local e AWS, consulte também
[`observability/README.md`](observability/README.md).

## Validação local

Pré-requisitos: Terraform 1.7+, Docker ativo, Node.js 22, npm, AWS CLI, uma sessão
válida do AWS Academy e a key pair `vockey` em `us-east-1`. Se a sessão não
estiver no perfil padrão, defina `AWS_PROFILE` antes dos comandos. Confirme a
conta selecionada:

```bash
aws sts get-caller-identity --region us-east-1
```

O provider usa a cadeia padrão de credenciais da AWS. Não há variável
`aws_account_id`; `deployment_namespace=g05-s3` e `regiao=us-east-1` já são os
padrões validados. Da raiz do repositório, execute:

```bash
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack validate
npm --prefix apps/backend/api run test:ci-policy
```

## Planejamento e aplicação

Salve o plano dentro do diretório ignorado `.terraform-artifacts`, valide seu
JSON no gate create-only e aplique exatamente o mesmo arquivo:

```bash
mkdir -p apps/fullstack/.terraform-artifacts
terraform -chdir=apps/fullstack plan \
  -input=false \
  -out=.terraform-artifacts/g05-s3.tfplan

# Forma geral: terraform show -json <saved plan> | node scripts/ci/validate-terraform-create-plan.mjs
terraform -chdir=apps/fullstack show -json \
  .terraform-artifacts/g05-s3.tfplan | \
  node scripts/ci/validate-terraform-create-plan.mjs

terraform -chdir=apps/fullstack apply \
  -input=false \
  .terraform-artifacts/g05-s3.tfplan
```

Só prossiga para um `apply` deliberado do plano salvo quando o gate aceitar o
JSON. Durante o `apply`, scripts locais publicam a imagem da API no ECR, o
frontend no Amplify e criam o bucket privado dos Flow Logs; mantenha Docker,
Node.js e AWS CLI disponíveis.

O SSH no bastion fica desativado por padrão. Para uma gravação que exija SSH,
gere um novo plano com `-var='bastion_admin_cidr=<IP-PUBLICO>/32'`; a validação
rejeita `0.0.0.0/0`. O acesso recomendado continua sendo SSM.

O estado legado pertence a outra conta e não pode ser adotado por esta stack.
Uma aplicação deliberada deve criar e preservar o novo estado local, necessário
para o teardown posterior dos recursos isolados.

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

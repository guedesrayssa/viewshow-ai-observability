# Infraestrutura fullstack

Este diretório contém o Terraform da stack AWS do View Show e suas configurações de observabilidade. O fluxo recomendado para o AWS Academy Learner Lab é feito pelo script `scripts/aws-learner-lab.mjs`, executado a partir da raiz do repositório (`g05`).

A stack cria a rede, API no ECS/Fargate, ALB, painel no Amplify, Cognito, DynamoDB, recursos de ingestão (S3, SQS, Glue e Athena), ECR e observabilidade necessária ao ambiente. O scheduler de ingestão e a observabilidade em EC2 começam desabilitados.

## Pré-requisitos

- Sessão ativa do AWS Academy na conta que receberá a stack, com a role `voclabs`;
- key pair `vockey` em `us-east-1`;
- Terraform `>= 1.7` e `< 2.0`;
- Node.js 22 e npm;
- AWS CLI v2 configurada;
- Docker em execução.

Confirme que a sessão da AWS está ativa antes de começar:

```bash
aws sts get-caller-identity --profile default --region us-east-1
```

Os comandos abaixo devem ser executados na raiz do repositório. Não crie arquivos `*.tfvars` ou use variáveis Terraform automáticas: o script usa a configuração validada para o Learner Lab.

## Setup completo

Use este comando para uma conta que ainda não possui a stack. Ele valida os pré-requisitos, gera e valida um plano de criação, pede confirmação, aplica a infraestrutura e cria o primeiro usuário do Cognito.

```bash
node scripts/aws-learner-lab.mjs setup
```

Durante a execução, informe o e-mail e a senha do usuário inicial. A senha deve ter ao menos oito caracteres, incluindo letra maiúscula, minúscula e número.

Para usar outro profile AWS apenas no setup:

```bash
node scripts/aws-learner-lab.mjs setup --profile <nome-do-profile>
```

`setup` é create-only: se já houver uma stack no state local, use `update` para um preset de atualização ou faça o destroy antes de criar um novo ambiente.

## Deploy da infraestrutura

Quando o usuário Cognito já não precisa ser criado, publique somente a stack:

```bash
node scripts/aws-learner-lab.mjs deploy
```

O comando executa `terraform init`, cria um plano, aceita apenas ações de criação ou no-op, mostra o resumo do ambiente e pede confirmação antes do `apply`. Mantenha Docker disponível, pois as imagens da API e da ingestão são publicadas no ECR durante o deploy.

Após concluir, consulte os endpoints:

```bash
terraform -chdir=apps/fullstack output -raw painel_url
terraform -chdir=apps/fullstack output -raw api_url_https
```

Para validar uma stack que já existe, incluindo pré-requisitos, state e outputs:

```bash
node scripts/aws-learner-lab.mjs check
```

## Destroy

> Atenção: este comando remove todos os recursos gerenciados pelo Terraform, incluindo os dados do bucket de ingestão e as imagens do ECR. A ação é irreversível.

Execute o destroy no checkout original que contém o state local da stack:

```bash
node scripts/aws-learner-lab.mjs destroy
```

O script cria um plano de destruição, exibe o escopo e solicita a confirmação exata apresentada no terminal antes de aplicar o plano. Ele não aceita opções adicionais. Após a remoção, os recursos deixam de gerar custos na AWS.

## Observações

- Preserve `apps/fullstack/terraform.tfstate`; ele é necessário para validar, atualizar e destruir a stack criada.
- Não execute `terraform apply` ou `terraform destroy` manualmente no Learner Lab. Use o script, que valida a conta, o workspace e o plano antes de alterar a AWS.
- Para mudanças permitidas em uma stack existente, consulte `plan-update` e `update` em `node scripts/aws-learner-lab.mjs --help`.

Documentação complementar: [infraestrutura e integração](../../artefatos/sprint3/infraestrutura-integracao.md), [ingestão](../backend/ingestion-data/README.md) e [observabilidade](observability/README.md).

# Infraestrutura fullstack

Este diretório contém o Terraform da stack AWS do View Show e suas configurações de observabilidade. O fluxo recomendado para o AWS Academy Learner Lab é feito pelo script `apps/scripts/aws-learner-lab.mjs`, executado a partir da raiz do repositório (`g05`).

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
node apps/scripts/aws-learner-lab.mjs setup
```

Durante a execução, informe o e-mail e a senha do usuário inicial. A senha deve ter ao menos oito caracteres, incluindo letra maiúscula, minúscula e número.

Para usar outro profile AWS apenas no setup:

```bash
node apps/scripts/aws-learner-lab.mjs setup --profile <nome-do-profile>
```

`setup` é create-only: se já houver uma stack no state local, use `update` para um preset de atualização ou faça o destroy antes de criar um novo ambiente.

## Deploy da infraestrutura

Quando o usuário Cognito já não precisa ser criado, publique somente a stack:

```bash
node apps/scripts/aws-learner-lab.mjs deploy
```

O comando executa `terraform init`, cria um plano, aceita apenas ações de criação ou no-op, mostra o resumo do ambiente e pede confirmação antes do `apply`. Mantenha Docker disponível, pois as imagens da API e da ingestão são publicadas no ECR durante o deploy.

Após concluir, consulte os endpoints:

```bash
terraform -chdir=apps/fullstack output -raw painel_url
terraform -chdir=apps/fullstack output -raw api_url_https
```

Para validar uma stack que já existe, incluindo pré-requisitos, state e outputs:

```bash
node apps/scripts/aws-learner-lab.mjs check
```

## Worker de análise (opcional)

O worker consome a fila de análise que a ingestão publica (uma única fila e uma única DLQ, `view-show-ingestion-analysis`), detecta anomalias, prevê o risco de QoE e grava incidentes e previsões que a API lê. Ele nasce desabilitado. Sem um model ID, `setup` e `deploy` preservam o modo sem LLM:

```bash
node apps/scripts/aws-learner-lab.mjs setup \
  --analysis-model apps/backend/agentic/models/approved.json \
  --analysis-catalog apps/backend/agentic/config/scope-catalog.pilot.json
```

O script valida os dois arquivos antes de qualquer chamada externa (o modelo precisa ter `approved: true`). Durante o `apply`, o Terraform constrói a imagem do worker no ECR e publica o modelo e o catálogo no bucket da ingestão, em `analysis/models/<sha256>.json` e `analysis/catalogs/<sha256>.json`. O bundle aprovado é gerado fora do repositório (a pasta `models/` é ignorada pelo git); veja o [guia do worker](../../artefatos/arquitetura/implementacao/worker-analise.md).

### Rollout Ollama em duas etapas

A URL precisa ser alcançável pelas subnets privadas da VPC e usar um IPv4 literal RFC1918 (`10/8`, `172.16/12` ou `192.168/16`) na raiz, sem DNS, caminho, usuário/senha, query ou fragmento. A variável fica apenas no ambiente do processo Terraform e não é gravada no manifest operacional:

```bash
export VIEW_SHOW_OLLAMA_BASE_URL="http://<ipv4-rfc1918>:11434"
export VIEW_SHOW_OLLAMA_MODEL_ID="<modelo-instalado-no-ollama>"
```

Quando o Ollama da faculdade não tem rota direta para a VPC, abra a ponte SSH
temporária em um único terminal antes de ativar o worker:

```bash
node apps/scripts/aws-learner-lab.mjs analysis-bridge
```

O comando pede interativamente o usuário/host do Ollama e o caminho local da
chave `vockey`; ele não grava esses valores. Mantenha-o aberto, copie o endpoint
privado informado para `VIEW_SHOW_OLLAMA_BASE_URL` no terminal que executará
`analysis-activate` e use `Ctrl+C` para encerrar os três túneis. A configuração
restrita de `sshd` no bastion (`PermitListen`) continua sendo pré-requisito único.

Para uma stack nova, passe também o model ID no `setup` ou `deploy`. O serviço é criado com zero réplicas:

```bash
node apps/scripts/aws-learner-lab.mjs deploy \
  --analysis-model apps/backend/agentic/models/approved.json \
  --analysis-catalog apps/backend/agentic/config/scope-catalog.pilot.json \
  --analysis-model-id "$VIEW_SHOW_OLLAMA_MODEL_ID"
```

Para complementar uma stack já existente, use o fluxo controlado:

```bash
# Etapa 1: provisiona observabilidade, imagem, artefatos e serviço com 0 réplicas.
node apps/scripts/aws-learner-lab.mjs analysis-prepare \
  --analysis-model apps/backend/agentic/models/approved.json \
  --analysis-catalog apps/backend/agentic/config/scope-catalog.pilot.json \
  --analysis-model-id "$VIEW_SHOW_OLLAMA_MODEL_ID"

# Valida a rota ECS -> Ollama sem consumir a fila.
node apps/scripts/aws-learner-lab.mjs analysis-check

# Valida Ollama e exportação OTLP para a observabilidade existente.
node apps/scripts/aws-learner-lab.mjs analysis-smoke

# Etapa 2: repete o check e permite somente a transição de 0 para 1 réplica.
node apps/scripts/aws-learner-lab.mjs analysis-activate

# Publica um evento global controlado e exige SUCCEEDED no DynamoDB.
node apps/scripts/aws-learner-lab.mjs analysis-canary
```

Cada `apply` pede uma confirmação exata. O validador recusa mudanças fora do conjunto esperado; ativação e rollback aceitam somente a alteração de `desired_count`. Para interromper o consumidor sem destruir a stack:

```bash
node apps/scripts/aws-learner-lab.mjs analysis-deactivate
```

`analysis-activate` e `analysis-deactivate` precisam novamente de `VIEW_SHOW_OLLAMA_BASE_URL` para que o plano preserve a task definition sem persistir o endpoint fora do state Terraform. Não use mais de uma réplica neste perfil. Para acompanhar o serviço depois da ativação:

```bash
aws logs tail /ecs/view-show-analysis-worker --follow --region us-east-1
```

O worker continua restrito ao perfil `learner-lab`. Sem uma rota privada aprovada até o Ollama, mantenha o serviço em zero réplicas ou use o provider `none`; a detecção e a previsão continuam disponíveis, mas o diagnóstico por LLM fica desativado.

O checklist completo, os critérios de bloqueio, o rollback e o modelo de
evidências ficam no [runbook de rollout do Agentic com Ollama](observability/docs/runbooks/agentic-ollama-deployment.md).

## Abrir o Grafana privado

Com a observabilidade provisionada e credenciais AWS ativas, abra o Grafana em
um único comando, no Linux, macOS ou Windows:

```bash
node apps/scripts/aws-learner-lab.mjs grafana
```

O comando abre o túnel SSM e informa `http://localhost:3002` e o usuário
`admin`. Ele permanece em execução até `Ctrl+C`. A senha é sensível e é lida
somente pela pessoa que possui o state Terraform local:

```bash
node apps/scripts/aws-learner-lab.mjs grafana --senha
```

Esse modo mostra a senha no terminal e não abre o túnel; use-o apenas em um
terminal privado.

## Destroy

> Atenção: este comando remove todos os recursos gerenciados pelo Terraform, incluindo os dados do bucket de ingestão e as imagens do ECR. A ação é irreversível.

Execute o destroy no checkout original que contém o state local da stack:

```bash
node apps/scripts/aws-learner-lab.mjs destroy
```

O script cria um plano de destruição, exibe o escopo e solicita a confirmação exata apresentada no terminal antes de aplicar o plano. Ele não aceita opções adicionais. Após a remoção, os recursos deixam de gerar custos na AWS.

## Observações

- Preserve `apps/fullstack/terraform.tfstate`; ele é necessário para validar, atualizar e destruir a stack criada.
- Não execute `terraform apply` ou `terraform destroy` manualmente no Learner Lab. Use o script, que valida a conta, o workspace e o plano antes de alterar a AWS.
- Para mudanças permitidas em uma stack existente, consulte `plan-update` e `update` em `node apps/scripts/aws-learner-lab.mjs --help`.

Documentação complementar: [infraestrutura e integração](../../artefatos/sprint3/infraestrutura-integracao.md), [ingestão](../backend/ingestion-data/README.md) e [observabilidade](observability/README.md).

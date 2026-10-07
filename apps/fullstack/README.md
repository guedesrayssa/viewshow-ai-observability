# Infraestrutura fullstack

Este diretório contém o Terraform da stack AWS do View Show e suas configurações de observabilidade. O fluxo recomendado para o AWS Academy Learner Lab é feito pelo script `apps/scripts/aws-learner-lab.mjs`, executado a partir da raiz do repositório (`g05`).

A stack cria a rede, API no ECS/Fargate, ALB, painel no Amplify, Cognito, DynamoDB, recursos de ingestão (S3, SQS, Glue e Athena), ECR e observabilidade necessária ao ambiente. O scheduler de ingestão e a observabilidade em EC2 começam desabilitados.

## Pré-requisitos

- Sessão ativa do AWS Academy na conta que receberá a stack, com a role `voclabs`;
- key pair `vockey` em `us-east-1`;
- Terraform `>= 1.7` e `< 2.0`;
- Node.js 22 e npm (o `.nvmrc` da raiz fixa a versão; com o nvm, rode `nvm use`);
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

## Subir a plataforma do zero (passo a passo)

Roteiro completo para uma conta de lab nova, até o painel mostrar dados. Todos os comandos rodam na raiz do repositório.

1. **Credenciais.** No AWS Academy, abra o Learner Lab, clique em **Start Lab** e, em **AWS Details**, clique em **Show** ao lado de **AWS CLI**. Com o bloco copiado, grave-o no arquivo de credenciais (isso substitui o conteúdo anterior) e confirme a conta. As credenciais expiram em cerca de 4 horas; ao expirar, cole um bloco novo e repita o comando que estava rodando.

   ```bash
   mkdir -p ~/.aws && pbpaste > ~/.aws/credentials && chmod 600 ~/.aws/credentials
   aws sts get-caller-identity
   ```

   O `pbpaste` é do macOS; em outros sistemas, cole o bloco no arquivo com um editor.
2. **State de outra conta.** O Learner Lab pode entregar uma conta diferente a cada sessão. Veja a que conta o state local pertence e, se não for a atual, mova-o para fora do repositório. Guarde-o: ele é necessário para desligar a stack antiga. Sem isso, o plano tenta reaproveitar recursos que não existem na conta nova.

   ```bash
   grep -o ':[0-9]\{12\}:' apps/fullstack/terraform.tfstate | sort -u
   mkdir -p ~/backup-terraform && mv apps/fullstack/terraform.tfstate* ~/backup-terraform/
   ```
3. **Infraestrutura.** Com o Docker em execução:

   ```bash
   node apps/scripts/aws-learner-lab.mjs setup
   ```

   Confirme com `s` e informe o e-mail e a senha do painel. Leva de 10 a 20 minutos, porque constrói e publica duas imagens, e no fim imprime os links do painel e da API.
4. **Dados.** Gere o dump reduzido (23 tabelas de fixture; prova o caminho de código, não volume ou capacidade), envie-o e rode o backfill sem ativar:

   ```bash
   node apps/scripts/aws-learner-lab.mjs build-snapshot
   node apps/scripts/aws-learner-lab.mjs seed
   ```

   Para um dump real, use as opções de `seed` descritas no [README da ingestão](../backend/ingestion-data/README.md).
5. **Ativação.** A API só lê o dataset depois de ativado; sem isso ela responde 503 e o painel fica vazio. É um passo separado e deliberado. Use um `--launch-attempt` novo a cada tentativa, porque repetir o mesmo valor reaproveita a task anterior (inclusive uma que falhou):

   ```bash
   apps/backend/ingestion-data/.venv/bin/python apps/backend/ingestion-data/scripts/run_task.py \
     --terraform-output terraform-output.json \
     --snapshot upload-result.json \
     --launch-attempt activate-1 \
     --activate
   ```

   No Windows, use `.venv\Scripts\python.exe`. Em cerca de dois minutos o manifesto ativo aparece:

   ```bash
   aws dynamodb get-item --table-name view-show-iac-operacional \
     --key '{"pk":{"S":"CONTROL#DATASET"},"sk":{"S":"ACTIVE"}}' \
     --query 'Item.activeDatasetVersion.S' --output text
   ```
6. **Conferência.** `node apps/scripts/aws-learner-lab.mjs check` valida stack, state e outputs, e `terraform -chdir=apps/fullstack output -raw painel_url` imprime o endereço do painel, onde você entra com o e-mail e a senha do passo 3.
7. **Ao terminar**, remova a stack (seção [Destroy](#destroy)) para parar o consumo de crédito.

### Problemas conhecidos

- **`the create-only gate rejected the plan ... terraform_data.imagem: rejected action must be create or no-op`.** A publicação da imagem falhou no meio (a internet caiu ou ocorreu o erro do keychain abaixo) e o Terraform marcou o recurso como falho. Publique a imagem à mão e limpe a marca. A `TAG` são os 12 primeiros caracteres do `triggers_replace` do recurso, e o `REPO_URL` é o `repository_url` do repositório ECR:

  ```bash
  terraform -chdir=apps/fullstack state show 'terraform_data.imagem'
  terraform -chdir=apps/fullstack state show 'aws_ecr_repository.api'
  REGIAO=us-east-1 REPO_URL=<repository_url> TAG=<12 primeiros caracteres> CONTEXTO="$PWD/apps/backend/api" node apps/fullstack/scripts/publicar-imagem.mjs
  terraform -chdir=apps/fullstack untaint 'terraform_data.imagem'
  ```

  Para a imagem da ingestão, troque por `terraform_data.ingestion_image[0]`, `aws_ecr_repository.ingestion` e `CONTEXTO="$PWD/apps/backend/ingestion-data"`. Depois repita o comando que falhou (`setup` ou `deploy`).
- **`error saving credentials ... already exists in the keychain (-25299)` (macOS).** As imagens da API e da ingestão são publicadas em paralelo, e dois `docker login` simultâneos no mesmo registro do ECR colidem. Rode `docker logout <conta>.dkr.ecr.us-east-1.amazonaws.com`, siga o item anterior para a imagem que falhou e repita o comando.
- **`AWS_REGION must be exactly us-east-1`** (ou erro parecido para `AWS_DEFAULT_REGION` e `AWS_DEFAULT_PROFILE`). O script recusa região ou profile diferentes na sessão do shell. Remova-os com `unset AWS_REGION AWS_DEFAULT_REGION AWS_DEFAULT_PROFILE` ou ajuste para `us-east-1` e `default`.
- **`ExpiredToken`, `InvalidClientTokenId` ou "active AWS credentials" ausente.** As credenciais do lab expiraram (cerca de 4 horas) ou o lab foi reiniciado: repita o passo 1.
- **`seed` termina com `container ingestion stopped with a non-zero exit code`.** Leia o log da task com `aws logs tail /ecs/view-show-ingestion-backfill --since 30m --region us-east-1`. Em stacks criadas antes da correção que trata as variáveis de análise vazias como desligadas (`bootstrap/config.py` da ingestão), o motivo é `ANALYSIS_FACT_CATALOG_LOCATION must be non-empty text without surrounding whitespace`, porque a imagem antiga recusava a variável vazia que o Terraform sempre declara. Refaça `destroy` e `setup` com a imagem atual.

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

## Abrir ou provisionar o Grafana privado

Com a stack fullstack existente e credenciais AWS ativas, prepare e abra o
Grafana em um único comando, no Linux, macOS ou Windows:

```bash
node apps/scripts/aws-learner-lab.mjs grafana
```

Na primeira execução, se a camada de observabilidade ainda não existir, o
script cria um plano protegido e pede a confirmação exata exibida no terminal
antes de criar a EC2 privada. Nas execuções seguintes ele não executa `plan` ou
`apply`: valida por SSM o Grafana, o CloudWatch e os dashboards de Ingestão e
Agentic e então abre o túnel.

O resumo informa `Infraestrutura: CREATED` ou `EXISTING`, a URL
`http://localhost:3002`, o usuário `admin` e, somente em um terminal interativo,
a senha. O túnel permanece em execução até `Ctrl+C`. `Ollama/LLM:
NOT_CONFIGURED` é um resultado saudável para o Grafana; significa apenas que a
parte opcional de LLM ainda não foi configurada.

Para ler somente a senha local, sem provisionar, validar a AWS ou abrir o
túnel:

```bash
node apps/scripts/aws-learner-lab.mjs grafana --senha
```

Use esse modo apenas em um terminal privado.

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

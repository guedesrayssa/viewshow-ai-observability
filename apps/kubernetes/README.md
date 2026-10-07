# View Show em Kubernetes (EKS)

A infraestrutura AWS fica em `apps/fullstack`; `apps/kubernetes` instala o runtime em uma segunda etapa, depois que o cluster existe. Isso evita que a conexão com um cluster ainda inexistente bloqueie o primeiro plano Terraform.

| Runtime anterior | Runtime atual |
| --- | --- |
| ECS Service da API | Deployment `api`, Service ClusterIP, HPA e PodDisruptionBudget |
| ECS Service de análise | Deployment `analysis-worker`, com SIGTERM e janela de 120 segundos |
| Task de backfill | Job criado do CronJob suspenso `ingestion-backfill` |
| Task de importação web | Job determinístico criado pela API em `<namespace>-imports` |
| EventBridge Scheduler de sync | CronJob `ingestion-sync`, a cada 15 minutos; painel controla `spec.suspend` |
| Export/ingest incremental | CronJobs a cada 15/5 minutos, sem sobreposição |
| ECS Service Auto Scaling | HPA para Pods + Cluster Autoscaler para nós EC2 |
| Execution/task roles | IRSA por ServiceAccount; nós só acessam ECR e APIs de infraestrutura |
| ALB registra ENIs das tasks | Load Balancer Controller registra IPs de Pods por TargetGroupBinding |
| Logs ECS/Container Insights | Fluent Bit + CloudWatch Agent, logs estruturados/EMF e Container Insights EKS |

Amplify, API Gateway HTTPS, ALB, Cognito, DynamoDB, S3 versionado, Athena, Glue, SQS/DLQs, VPC, NAT e Flow Logs continuam na AWS. A pilha opcional Grafana/Prometheus/Loki/Tempo/Alloy mantém seu host EC2 e recebe a telemetria dos Pods. O MySQL de snapshot é um **sidecar nativo** (`initContainers`, `restartPolicy: Always`): o worker só começa depois do startup probe e o MySQL encerra quando o Job termina. Dados temporários usam `emptyDir` e `fsGroup`, com disco de 300 GiB nos nós, requests/limits e orçamento do worker de 64 GiB.

## Pré-requisitos

Use Terraform >= 1.9, Node 22, AWS CLI v2, Docker/buildx, kubectl compatível com Kubernetes 1.35 e Helm 3. A conta precisa permitir EKS, EC2, IAM/OIDC, políticas e access entries. **O perfil `learner-lab` controla defaults de dados.** O modo padrão `eks_iam_mode=managed` cria roles/IRSA e exige permissões IAM. No AWS Academy com criação de IAM bloqueada, use o modo explícito abaixo, que reutiliza recursos fornecidos pelo lab. Se o próprio EKS estiver proibido, será necessária outra conta autorizada.

Os operadores precisam poder obter os segredos de snapshot/live no Secrets Manager. Se a observabilidade EC2 estiver habilitada, precisam também executar `ssm:SendCommand` com `AWS-RunShellScript` e consultar seu resultado nessa instância. O deploy atualiza o dashboard pelo SSM; o Grafana recarrega o arquivo automaticamente. A migração preserva a instância e seus volumes históricos; alterações futuras de cloud-init precisam de atualização operacional explícita. A role configurada em `eks_admin_role_arn` recebe acesso administrativo; informe um ARN IAM permanente, nunca um ARN STS de sessão. O endpoint privado fica ativo; o público aceita somente `eks_public_access_cidrs`.

Copie `apps/fullstack/terraform.tfvars.example` para `apps/fullstack/terraform.tfvars`, ajuste a role e o CIDR do operador/runner e selecione `AWS_PROFILE`. Os arquivos de estado, planos, tfvars e outputs sensíveis nunca devem entrar no Git.

## AWS Academy com IAM pré-provisionado

Configure somente no perfil `ambiente=learner-lab`:

```hcl
eks_iam_mode = "learner-lab-existing"
eks_existing_cluster_role_arn = "arn:aws:iam::ACCOUNT:role/LabEksClusterRole-NAME"
eks_existing_node_role_arn = "arn:aws:iam::ACCOUNT:role/LabRole"
eks_existing_instance_profile = "LabInstanceProfile"
eks_admin_role_arn = "arn:aws:iam::ACCOUNT:role/voclabs"
# If the lab caps EBS at 100 GiB, use an allowed instance with local SSDs.
eks_node_instance_types = ["i3.large"]
eks_node_root_volume_gib = 100
eks_node_instance_store = true
```

Com `eks_node_instance_store=true`, AL2023/nodeadm prepara os SSDs locais em RAID0 para kubelet/containerd. A configuração exige discos locais suficientes para os 192 GiB reservados pelos Pods de snapshot; o i3.large oferece 475 GB. O conteúdo é temporário e se perde quando o nó termina, como o `emptyDir` original. Antes do primeiro snapshot, confirme o recurso `ephemeral-storage` em `kubectl describe nodes`. Veja a [API oficial nodeadm](https://awslabs.github.io/amazon-eks-ami/nodeadm/doc/api/).

Descubra o ARN exato da role de cluster com `aws iam list-roles`; o Academy a fornece com sufixo variável. Confirme `AmazonEKSClusterPolicy` no control plane, e `AmazonEKSWorkerNodePolicy`, acesso ECR, rede, logs e serviços de dados na LabRole. Esse modo não cria/altera roles, policies, OIDC ou associações Pod Identity. O grupo de nós usa a LabRole existente; os SDKs nos Pods obtêm credenciais rotacionadas de IMDSv2 com hop limit 2. Nenhuma credencial temporária da CLI é copiada para Secrets. Em snapshots, o lab reserva metade da CPU configurada e conserva o limite de burst, permitindo rodar o Pod em instâncias `large` de dois vCPUs; memória e disco permanecem iguais.

**Limite do lab:** os workloads compartilham as permissões da LabRole; o isolamento IAM por ServiceAccount e as negações IAM específicas de importação não se aplicam. RBAC, namespaces, NetworkPolicies e validações de domínio permanecem. Esse modo é bloqueado em produção, onde IMDS fica isolado e IRSA mantém as roles individuais. Veja a [documentação AWS de IMDSv2 no EKS](https://aws.amazon.com/about-aws/whats-new/2020/08/amazon-eks-supports-ec2-instance-metadata-service-v2/).

Ao usar a sessão CLI já assumida como `voclabs`, gere kubeconfig **sem** `--role-arn`: `aws eks update-kubeconfig --name CLUSTER --region REGION`. Isso evita tentar assumir novamente a mesma role. Mantenha o kubeconfig privado e use o nome/ARN do cluster dos outputs.

## Provisionamento novo

Execute na raiz do repositório:

```bash
terraform -chdir=apps/fullstack init
terraform -chdir=apps/fullstack plan -out=kubernetes.tfplan
terraform -chdir=apps/fullstack show -json kubernetes.tfplan \
  | node apps/scripts/terraform/validate-create-plan.mjs
terraform -chdir=apps/fullstack apply kubernetes.tfplan
terraform -chdir=apps/fullstack output -json kubernetes_runbook
```

Crie o usuário inicial pelo console do Cognito no pool indicado por `terraform output cognito_user_pool_id`, com status confirmado e senha permanente, seguindo o fluxo administrativo já usado pela equipe.

Execute o comando `kubeconfig` do output `kubernetes_runbook` usando a role autorizada. Depois:

```bash
node apps/kubernetes/deploy.mjs
terraform -chdir=apps/fullstack output -raw painel_url
terraform -chdir=apps/fullstack output -raw api_url_https
```

O deploy confere o cluster selecionado, carrega segredos em memória e instala versões fixadas do Load Balancer Controller, Metrics Server, Cluster Autoscaler e CloudWatch Observability antes da aplicação. Namespace é criado separadamente do release Helm. Valores sensíveis são enviados por stdin, sem arquivo de valores no disco. `--render` imprime os valores **com segredos** para diagnóstico local; não use em logs compartilhados.

API: `kubectl -n view-show rollout status deployment/api`. Worker: `kubectl -n view-show rollout status deployment/analysis-worker`. O worker conserva `analysis_worker_habilitado=false` por default. Para habilitá-lo, configure modelo aprovado e catálogo com `analysis_model_file`/`analysis_scope_catalog_file` (caminhos relativos a `apps/fullstack`), ou URIs S3 e SHA-256. O runtime valida o modelo. Os ARNs de modelo Bedrock e os prefixos S3 devem corresponder aos artefatos autorizados nas policies.

Credenciais live continuam externas: preencha o segredo JSON com `host`, `port`, `username`, `password`, `database` e execute novamente o deploy. Um segredo live sem versão é tolerado apenas enquanto seu CronJob está suspenso; o template referencia um Secret ausente, de modo que habilitar antes de configurar credenciais não inicia processamento. Complete essa configuração antes de habilitar no painel. Segredos são sincronizados a cada deploy; após rotação, repita o deploy. Snapshot recebe senha gerada no Terraform no laboratório; produção fornece o segredo raw existente.

## Migração de uma stack ECS existente

Reserve uma janela de manutenção. A aplicação usa o mesmo ALB e tabela operacional: executar API ECS e Kubernetes simultaneamente pode produzir reconciliações concorrentes e tráfego misturado. Não use este plano como estratégia sem interrupção.

1. No checkout que possui o **estado real**, faça backup privado do estado, registre a versão ativa das imagens, outputs e task definitions. Preserve o namespace e todas as variáveis dos dados; não copie estados/segredos para esta branch.
2. Desabilite sync pelo painel, suspenda também os schedules incrementais legados e aguarde tasks batch, imports e mensagens de análise em processamento concluírem. Nenhum import ativo pode carregar um `taskArn` ECS ao iniciar o reconciliador Kubernetes.
3. Gere o plano desta branch com o mesmo estado/namespace. Valide com `validate-create-plan.mjs --migration --update`. O gate permite retirar ECS, autoscaling ECS e EventBridge; recusa apagar/substituir DynamoDB, S3, Cognito, filas e outros recursos persistentes.
4. Revise o plano completo e aplique o plano salvo. O ECS será removido; o ALB ficará temporariamente sem API até o deploy Kubernetes. A criação do EKS e dos nós pode levar vários minutos. Imagens e tabelas preservam nomes existentes.
5. Atualize kubeconfig e rode `deploy.mjs`. Verifique login, painel, `/health`, importação sem ativação, reanálise e consumo da fila. Teste sync com credenciais homologadas e confirme um Job concluído antes de liberar operação normal.
6. Os blocos `removed { destroy = false }` retiram logs antigos e a DLQ do Scheduler do gerenciamento **sem apagá-los**. Registre esses recursos retidos para consulta/custo. Reabilite sync pelo painel somente após homologação.

Rollback durante a janela: suspenda CronJobs e os Deployments Kubernetes, reverta o código para a versão ECS registrada e planeje com o **estado atualizado**, preservando os mesmos dados/namespace. Recrie os serviços e task definitions legados, confirme targets saudáveis e depois reabilite schedules. Não restaure um backup de estado sobre recursos novos sem reconciliação; não execute dois reconciliadores/consumidores concorrentes. Rollback entre versões Kubernetes usa `helm rollback view-show <revision> -n view-show`.

## Operação

```bash
kubectl -n view-show get deployments,pods,hpa,cronjobs,jobs
kubectl -n view-show-imports get jobs,pods
kubectl -n view-show logs -f deployment/api
kubectl -n view-show logs -f deployment/analysis-worker
kubectl -n view-show-imports logs -f job/IMPORT_JOB -c ingestion
kubectl -n view-show describe job JOB_NAME
kubectl -n view-show get events --sort-by=.lastTimestamp
```

A API usa o token projetado de ServiceAccount (relido a cada requisição), HTTPS com a CA do cluster e RBAC limitado ao CronJob de sync e criação/leitura de Jobs no namespace de importação. Esse namespace contém somente a role de importação, sem acesso Kubernetes a Secrets. O atributo persistido `taskArn` mantém seu nome para compatibilidade de dados, mas passa a conter `k8s://namespace/jobs/name/uid`; o UID evita confundir um Job recriado. Nomes são derivados do ULID; HTTP 409 após uma resposta perdida recupera o mesmo Job. Jobs retêm evidência por sete dias e não repetem automaticamente o processamento (`backoffLimit: 0`).

CronJobs usam UTC, `Forbid`, limite de início tardio e limites de duração. Backfill/import ficam permanentemente suspensos como templates manuais. Helm preserva `spec.suspend` de sync já gerenciado pelo painel e as réplicas da API gerenciadas pelo HPA. `Forbid` atua por CronJob; os locks/leases de domínio continuam protegendo operações distintas.

O upload seguro permanece em `apps/backend/ingestion-data/scripts/upload_snapshot.py`. Para um snapshot com evidência `bucket`, `key`, `versionId`, `sha256`, `size`, `snapshotExtractedOn`, faça o backfill:

```bash
node apps/kubernetes/run-job.mjs upload-result.json attempt-1
```

O comando valida conta/cluster, objeto/version/metadata/size S3, exige CronJobs live suspensos e cria um Job com senha própria e `ACTIVATE_CANDIDATE=false`. Repetir a mesma tentativa reutiliza o Job; uma tentativa deliberadamente nova usa outro identificador. A senha fica em um Secret por Job, removido com ele após o TTL. A ativação permanece no fluxo administrativo já existente da aplicação. O antigo `run_task.py` e os comandos ECS `seed`, `update`, `all`, `destroy` e `import-canary` foram retirados; o benchmark local mantém seus dados/contratos, e o canário web usa o fluxo do painel.

## Validação e custo

```bash
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack validate
terraform -chdir=apps/fullstack test
npm --prefix apps/backend/api run verify
node --test apps/kubernetes/tests/*.test.mjs apps/scripts/tests/*.test.mjs
helm lint apps/kubernetes/chart
```

EKS cobra pelo control plane; os dois nós mínimos, volumes EBS, NAT, ALB e observabilidade também geram custo enquanto provisionados. HPA não reduz os nós abaixo de dois.

O modo Academy foi implantado em 01/10/2026 com EKS 1.35, dois nós `i3.large` Ready e aproximadamente 397 GiB de armazenamento temporário alocável por nó. Load Balancer Controller, Metrics Server, Cluster Autoscaler e CloudWatch ficaram operacionais. Um Job derivado do template de importação validou MySQL, credenciais da LabRole, S3 e DynamoDB; worker e sidecar terminaram com código zero. Os testes públicos IT-AWS-01, 02 e 05 validaram painel/health, login Cognito, bloqueio sem sessão e reserva idempotente de multipart S3/DynamoDB, com limpeza dos dados e usuário temporários. Grafana respondeu com saúde da base OK. Não foi executado um snapshot completo nem sync live: esses fluxos exigem os dados/credenciais da equipe; análise Bedrock e schedules continuam desabilitados por configuração.

Referências: [versões EKS](https://docs.aws.amazon.com/eks/latest/userguide/platform-versions.html), [access entries](https://docs.aws.amazon.com/eks/latest/userguide/creating-access-entries.html), [sidecars nativos](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [CronJobs](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/), [policy do Load Balancer Controller 2.14.1](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v2.14.1/docs/install/iam_policy.json).

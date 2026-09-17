# Arquitetura Final — Amazon EKS

> Este documento especifica a arquitetura de implantação do View Show na AWS com Amazon EKS e perfis Fargate. A aplicação é publicada por manifests Kubernetes YAML versionados; Helm é usado somente para instalar e atualizar o AWS Load Balancer Controller oficial.

## Sumário

1. [Escopo](#1-escopo)
2. [Diagrama de implantação](#2-diagrama-de-implantação)
3. [Componentes da arquitetura](#3-componentes-da-arquitetura)
4. [Organização e publicação dos manifests](#4-organização-e-publicação-dos-manifests)
5. [Plano de implantação](#5-plano-de-implantação)
6. [Segurança, escala e observabilidade](#6-segurança-escala-e-observabilidade)
7. [Evidências de aceite](#7-evidências-de-aceite)

---

## 1. Escopo

&emsp;A arquitetura executa a API, a ingestão e o worker de análise em Pods Amazon EKS Fargate. O frontend Next.js permanece no AWS Amplify. A entrada HTTP é feita por API Gateway e Application Load Balancer (ALB). Os Pods executam apenas em sub-redes privadas e acessam serviços AWS por roles IAM associadas às ServiceAccounts.

&emsp;A infraestrutura AWS é declarada por Terraform. Os recursos da aplicação são declarados em YAML e aplicados com `kubectl`. Não há Helm Chart próprio e não há Kustomize na solução. O único uso de Helm é o chart oficial, com versão fixa, do AWS Load Balancer Controller.

## 2. Diagrama de implantação

<div align="center">

<strong>Figura 1: Diagrama de implantação da arquitetura final com Amazon EKS</strong>
<img src="../../assets/diagrama-implantacao-aws3.jpg" alt="Diagrama de implantação manual com EKS, duas zonas de disponibilidade, sub-redes públicas e privadas"/>

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;O diagrama organiza a solução em região AWS, VPC, AZs, sub-redes públicas, sub-redes privadas, serviços gerenciados e componentes externos. As setas indicam requisições, identidade, dados, processamento assíncrono, observabilidade e operações de entrega.

## 3. Componentes da arquitetura

<div align="center">

<sup>Tabela 1: Componentes e responsabilidades da arquitetura final</sup>

</div>

| Camada | Componente | Configuração e responsabilidade |
| --- | --- | --- |
| Experiência | AWS Amplify | Publica o frontend Next.js e encaminha `/api`, `/auth` e `/health` pela mesma origem do dashboard. |
| Borda HTTP | API Gateway | Fornece HTTPS para o proxy same-origin do Amplify e encaminha as requisições ao ALB. |
| Borda HTTP | Application Load Balancer | Opera nas duas sub-redes públicas, valida `/health` e usa targets IP para os Pods Fargate. |
| Rede | VPC e sub-redes | Usa a VPC `10.0.0.0/16`, com duas sub-redes públicas e duas privadas em AZs distintas. Os Pods não recebem IP público. |
| Rede | Internet Gateway, NAT e endpoints | Internet Gateway atende a borda pública; um NAT Gateway por AZ fornece saída resiliente; endpoints de gateway dão acesso privado a S3 e DynamoDB. |
| Orquestração | Amazon EKS | Fornece o control plane Kubernetes gerenciado. |
| Orquestração | Perfis EKS Fargate | Selecionam Pods por namespace e rótulo e os executam em sub-redes privadas. A arquitetura usa perfis elegíveis para `kube-system` e `view-show`. |
| Orquestração | AWS Load Balancer Controller | É instalado pelo chart oficial da AWS, com versão fixa. Observa `Ingress` e `Service`, e reconcilia ALB, listeners, regras e targets IP. |
| API | `Deployment`, `Service` e `Ingress` | A API inicia com duas réplicas, expõe um `Service` `ClusterIP`, recebe regras de `Ingress` e responde a probes em `/health`. |
| Ingestão | `CronJob` | Executa janelas idempotentes de coleta, registra histórico no S3 e produz mensagens de análise. |
| Análise | `Deployment` de worker | Consome a SQS, processa análises e persiste os resultados no DynamoDB. |
| Identidade AWS | ServiceAccounts e IRSA | Cada workload possui uma ServiceAccount e uma role IAM de privilégio mínimo. A pod execution role do Fargate não concede permissões à aplicação. |
| Dados | DynamoDB | Armazena as tabelas operacional e Golden Set. |
| Dados | S3, SQS e DLQ | S3 armazena histórico; SQS desacopla produtores e consumidor; DLQ retém mensagens que excedem as tentativas configuradas. |
| Autenticação | Cognito e SSO | Cognito centraliza sessão e federação corporativa OIDC ou SAML. |
| Entrega | ECR | Armazena imagens. Os manifests referenciam cada imagem por digest. |
| Observabilidade | CloudWatch | Consolida logs, métricas e alarmes da borda, dos Pods, do HPA e da SQS/DLQ. |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

## 4. Organização e publicação dos manifests

### 4.1 Estrutura do repositório

&emsp;Os recursos Kubernetes da aplicação devem ficar no diretório `k8s/`. Os arquivos usam YAML puro, sem templating. O nome numérico mantém uma ordem explícita de aplicação e facilita a revisão do diff em pull requests.

```text
k8s/
  00-namespace.yaml
  10-serviceaccounts.yaml
  20-api-deployment.yaml
  21-api-service.yaml
  22-api-hpa.yaml
  30-worker-deployment.yaml
  31-ingestion-cronjob.yaml
  40-ingress.yaml
```

&emsp;Os valores estáveis da aplicação ficam nos manifests. Dados sensíveis não são versionados em YAML nem incluídos na imagem. A distribuição de segredos deve usar um mecanismo compatível com EKS Fargate e preservar a separação de permissões por ServiceAccount.

### 4.2 Imagens e versões

&emsp;A API, o worker e a ingestão usam imagens no ECR identificadas por digest. A atualização de versão ocorre por alteração explícita do campo `image` nos arquivos `20-api-deployment.yaml`, `30-worker-deployment.yaml` e `31-ingestion-cronjob.yaml`. A alteração é revisada em pull request e permite recuperar uma revisão anterior do manifest sem resolver tags mutáveis.

### 4.3 Fluxo de publicação

&emsp;O fluxo de publicação é declarativo e não depende de chart próprio:

```bash
kubectl diff -f k8s/
kubectl apply -f k8s/
```

&emsp;O comando é executado com o contexto correto do cluster EKS e somente após a revisão dos manifests. `kubectl apply` cria ou atualiza os recursos declarados no diretório. A remoção de recursos é explícita, por exemplo com `kubectl delete -f k8s/31-ingestion-cronjob.yaml`; não é usado `--prune` no fluxo inicial.

### 4.4 Uso restrito de Helm

&emsp;Helm não empacota nem publica a aplicação. Ele instala somente o AWS Load Balancer Controller oficial no namespace `kube-system`. A versão do chart e os valores obrigatórios — nome do cluster, região, VPC e ServiceAccount com IRSA — devem ficar registrados no script ou procedimento de infraestrutura.

&emsp;Essa separação mantém os manifests da aplicação pequenos, legíveis e auditáveis, sem replicar localmente os recursos internos do controlador de carga.

## 5. Plano de implantação

### 5.1 Pré-requisitos

&emsp;O deploy requer Terraform, Docker, Node.js, npm, AWS CLI, `kubectl` e Helm. Helm é necessário apenas para instalar ou atualizar o AWS Load Balancer Controller. A conta deve ter permissões para EKS, Fargate profiles, IAM/OIDC, ELBv2, ECR, DynamoDB, S3, SQS, Cognito e CloudWatch.

```bash
aws sts get-caller-identity --region us-east-1
aws eks list-clusters --region us-east-1
kubectl version --client
helm version
```

### 5.2 Etapas de provisionamento

<div align="center">

<sup>Tabela 2: Etapas de provisionamento da arquitetura final na AWS</sup>

</div>

| Etapa | Recursos e ações | Critério de aceite |
| --- | --- | --- |
| 1. Identidade e cotas | Confirmar conta, região, permissões, quotas EKS/Fargate e capacidade de IP das sub-redes privadas. | Conta e região conferidas; capacidade compatível com Pods e add-ons. |
| 2. Rede e segurança | Provisionar VPC, duas sub-redes públicas, duas privadas, rotas, Security Groups, endpoints S3/DynamoDB, NAT por AZ e tags de descoberta do ALB. | Pods sem IP público; ALB descoberto nas duas AZs; saída privada funcional. |
| 3. EKS e Fargate | Provisionar control plane, provider OIDC, pod execution role e perfis Fargate para `kube-system` e `view-show`. | Cluster ativo; CoreDNS e Pods elegíveis em sub-redes privadas. |
| 4. Add-on de carga | Criar role IRSA do controlador e instalar a versão aprovada do AWS Load Balancer Controller por Helm. | Controller `Ready`, ServiceAccount correta e reconciliação habilitada. |
| 5. Identidade da aplicação | Criar ServiceAccounts e roles IRSA da API, worker e ingestão. | Cada Pod assume somente a role prevista para seu workload. |
| 6. Imagens e manifests | Publicar imagens no ECR por digest e aplicar os manifests do diretório `k8s/`. | API, worker e `CronJob` criados com imagens rastreáveis. |
| 7. Entrada HTTP | Aplicar o `Ingress`, validar o ALB, os targets IP e o endpoint `/health`, e integrar o API Gateway. | Targets IP saudáveis e resposta funcional pelo dashboard. |
| 8. Dados e fila | Validar DynamoDB, S3, SQS/DLQ, ingestão idempotente e consumo pelo worker. | Dados persistidos, mensagem processada e falha encaminhada à DLQ. |
| 9. Escala e observabilidade | Configurar HPA da API, mecanismo de escala do worker, dashboards e alarmes CloudWatch. | Escala, logs e métricas observáveis para borda, Pods e fila. |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 5.3 Recuperação operacional

&emsp;O rollback da aplicação é feito aplicando uma revisão anterior dos manifests que referencia os digests de imagem conhecidos. O rollback da infraestrutura é feito exclusivamente por Terraform, com plano revisado. Antes de uma alteração de borda, deve existir uma rota de retorno validada para a revisão anterior.

## 6. Segurança, escala e observabilidade

### 6.1 Segurança

- Apenas o ALB recebe tráfego público; Pods Fargate ficam em sub-redes privadas.
- Security Groups permitem acesso à porta da API somente a partir do security group do ALB.
- Cada workload recebe uma role IAM própria por IRSA.
- Endpoints de gateway evitam que o acesso a S3 e DynamoDB dependa do NAT Gateway.
- Segredos não são incluídos em imagens nem em manifests versionados.
- Imagens são referenciadas por digest e possuem origem rastreável no ECR.

### 6.2 Escala e disponibilidade

&emsp;A API usa HPA com mínimo de duas e máximo de quatro réplicas. O worker usa KEDA ou HPA com métrica externa baseada na profundidade da SQS; a escolha deve ser definida antes do deploy. O ALB opera em duas sub-redes públicas e envia tráfego somente a Pods saudáveis.

&emsp;EKS Fargate não suporta `DaemonSet` nem `topologySpreadConstraints`. Agentes de observabilidade por nó devem ser substituídos por sidecars ou coletores compatíveis. A distribuição da API entre AZs é validada por perfis Fargate separados por sub-rede/AZ e por testes de implantação; ela não é presumida somente pelo scheduler.

### 6.3 Observabilidade

&emsp;O CloudWatch deve registrar logs, métricas e alarmes para saúde dos targets do ALB, latência e erros da API, réplicas do HPA, profundidade e idade da SQS, mensagens da DLQ, duração e resultado do `CronJob` e falhas de integração com DynamoDB, S3 e Cognito.

## 7. Evidências de aceite

- cluster EKS ativo, perfis Fargate criados e Pods em sub-redes privadas;
- AWS Load Balancer Controller saudável e `Ingress` reconciliado;
- ALB em duas sub-redes públicas com targets IP `healthy` no endpoint `/health`;
- autenticação pelo Amplify, API Gateway e Cognito;
- API e worker executando com roles IRSA de menor privilégio;
- execução do `CronJob`, escrita no S3, envio à SQS, consumo pelo worker e persistência no DynamoDB;
- mensagem de falha encaminhada à DLQ;
- HPA da API e mecanismo de escala do worker demonstrados sob carga;
- logs, métricas e alarmes disponíveis no CloudWatch;
- aplicação e rollback de uma revisão anterior dos manifests validados.

## Referências técnicas

- [Gerenciamento declarativo com `kubectl apply`](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/)
- [AWS Load Balancer Controller no EKS](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html)
- [Amazon EKS com AWS Fargate](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)
- [Perfis Fargate](https://docs.aws.amazon.com/eks/latest/userguide/fargate-profile.html)
- [IAM Roles for Service Accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)

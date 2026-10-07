# Infraestrutura View Show — EKS

Esta stack provisiona VPC/NAT, EKS/nós privados, ECR, ALB/API Gateway, Amplify, Cognito, DynamoDB, S3/Athena/Glue, SQS e observabilidade AWS. O runtime Kubernetes é instalado em uma segunda etapa por `apps/kubernetes/deploy.mjs`.

Siga o [runbook Kubernetes](../kubernetes/README.md) para configurar a conta, provisionar uma stack nova, migrar o estado ECS existente, executar backfill e fazer rollback. Use [terraform.tfvars.example](terraform.tfvars.example) como ponto de partida. O perfil Learner Lab não remove a necessidade de permissões EKS/IAM.

Os arquivos `ecs.tf`, `ingestion-ecs.tf`, `autoscaling.tf` e `ingestion-scheduler.tf` foram substituídos por `eks.tf`, `workloads.tf`, `kubernetes-iam.tf` e o chart em `apps/kubernetes/chart`. O Terraform mantém os contratos de dados e nomes físicos da stack existente. Estado, planos e segredos devem permanecer privados.

A [observabilidade](observability/README.md) integra métricas RED, exemplares,
logs com request/trace ID, Loki e Tempo ao runtime atual. O
[artefato de testes](../../artefatos/testes-carga-finais.md) preserva as medições
locais, ECS e EKS com sua imagem e data, além dos gráficos retrospectivos.
As correções Windows do antigo launcher permanecem no módulo ECS histórico;
elas não reativam `grafana`, `update` ou `analysis-*` na CLI Kubernetes atual.

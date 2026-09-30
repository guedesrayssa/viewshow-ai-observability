# Deploy do backend em Kubernetes

A API roda no Deployment `api` do EKS, acessível pelo Service ClusterIP e pelo ALB com TargetGroupBinding. HPA controla as réplicas; os secrets de autenticação e cursores são Kubernetes Secrets.

Siga o [runbook de implantação e migração](../../../kubernetes/README.md). Na raiz, após provisionar Terraform e selecionar o kubeconfig:

```bash
node apps/kubernetes/deploy.mjs
kubectl -n view-show rollout status deployment/api
kubectl -n view-show logs -f deployment/api
```

Importação web cria Jobs no namespace `view-show-imports`; o controle live modifica o CronJob `ingestion-sync`. Os contratos HTTP e a persistência continuam compatíveis. Conclua imports ECS ativos antes da migração.

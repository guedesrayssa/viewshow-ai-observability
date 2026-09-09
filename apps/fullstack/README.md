# Infraestrutura fullstack

Este diretório centraliza a infraestrutura como código do View Show:

- Terraform da stack AWS atualmente implementada — API TypeScript em ECS,
  ingresso, frontend no Amplify e duas tabelas DynamoDB;
- Docker Compose e configurações da observabilidade local;
- scripts auxiliares de publicação usados pelo Terraform.

Integrações sem runtime no repositório (Cognito, ingestão, data lake, filas e
workers) ficam explicitamente fora desta stack. A autenticação expõe apenas o
contrato federado e falha fechado até existir um provedor corporativo real.
O build de produção do painel nunca habilita dados de exemplo: falhas das APIs
permanecem visíveis como estados vazios, parciais ou indisponíveis.

A documentação canônica de arquitetura, configuração e operação está em
[`documentation/infraestrutura-integracao.md`](documentation/infraestrutura-integracao.md).
Para a stack LGTM local, consulte também
[`observability/README.md`](observability/README.md).

## Validação local

```bash
cd apps/fullstack
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
docker compose -f docker-compose.observability.yml config --quiet
```

Esses comandos validam a configuração localmente. Eles não executam deploy nem
comprovam uma aplicação da stack na AWS. Os valores usados para assinar sessão
e paginação são gerados separadamente pelo Terraform, injetados apenas na task
da API e não expostos como outputs.

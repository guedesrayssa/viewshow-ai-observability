# Infraestrutura fullstack

Este diretório centraliza toda a infraestrutura como código do View Show:

- Terraform da stack AWS;
- Docker Compose e configurações da observabilidade local;
- scripts auxiliares de publicação.

A documentação canônica de arquitetura, configuração, deploy, segurança,
operação e troubleshooting está em
[`documentation/infraestrutura-integracao.md`](documentation/infraestrutura-integracao.md).

Para a stack LGTM local, consulte também
[`observability/README.md`](observability/README.md).

## Validação rápida

```bash
cd apps/fullstack
terraform fmt -check -recursive
terraform init
terraform validate
docker compose -f docker-compose.observability.yml config --quiet
```

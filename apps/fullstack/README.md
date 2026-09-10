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

Para revisar uma implantação isolada na conta-alvo, salve o plano e informe
obrigatoriamente o namespace da Sprint 3:

```bash
terraform -chdir=apps/fullstack plan -out=g05-s3.tfplan \
  -var='deployment_namespace=g05-s3'
# Forma geral: terraform show -json <saved plan> | node scripts/ci/validate-terraform-create-plan.mjs
terraform show -json apps/fullstack/g05-s3.tfplan | node scripts/ci/validate-terraform-create-plan.mjs
terraform -chdir=apps/fullstack apply -input=false g05-s3.tfplan
```

Só prossiga para um `apply` deliberado do plano salvo quando o gate aceitar o
JSON. Aplique exatamente esse arquivo, sem gerar outro plano entre o gate e o
`apply`. Isso mantém a revisão e a aplicação vinculadas ao mesmo artefato.

Esses comandos validam a configuração localmente. Eles não executam deploy nem
comprovam uma aplicação da stack na AWS. Os valores usados para assinar sessão
e paginação são gerados separadamente pelo Terraform, injetados apenas na task
da API e não expostos como outputs.

O estado legado pertence a outra conta e não pode ser adotado por esta stack.
Uma aplicação deliberada deve criar e preservar o novo estado local, necessário
para o teardown posterior dos recursos isolados.

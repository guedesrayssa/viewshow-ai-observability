# Deploy do backend no ECS

O repositório não possui pipeline automático de GitLab. Este documento explica
como verificar e provisionar manualmente a infraestrutura que publica o backend
no ECS.

## Como o fluxo funciona

1. Execute os testes locais da API.
2. Valide as credenciais temporárias do AWS Academy.
3. Na raiz do repositório, execute `node apps/scripts/aws-learner-lab.mjs deploy`.
4. O comando cria e valida o plano Terraform, pede confirmação e aplica a stack.
5. Confirme a rota `/health` com a URL gerada pelo Terraform.

## Recursos utilizados

- Conta AWS: a conta ativa do Learner Lab, confirmada por
  `aws sts get-caller-identity`
- Região: `us-east-1`
- Namespace do Terraform: `view-show` (consulte
  `terraform output -raw deployment_namespace`)
- ECR: `view-show-api`
- Cluster ECS: `view-show-cluster`
- Serviço ECS: `view-show-api-service`
- Task definition: `view-show-api-task`
- Container: `view-show-api`
- Load Balancer: `view-show-alb`
## Credenciais do AWS Academy Lab

As credenciais expiram sempre que o Lab é encerrado. Depois de iniciar um novo Lab:

1. Atualize o profile local `default` da AWS CLI.
2. Confirme a conta e a role:

   ```bash
   aws sts get-caller-identity
   ```

   Registre a conta retornada para a sessão atual e confirme que a role contém
   `voclabs`. Não fixe um ID de conta no código ou no runbook: cada Learner Lab
   pode usar uma conta diferente.

3. Execute o deploy manual a partir da raiz:

   ```bash
   node apps/scripts/aws-learner-lab.mjs deploy
   ```

Nunca coloque credenciais AWS em argumentos, logs ou no repositório.

## Como verificar se funcionou

Na AWS, o serviço `view-show-api-service` deve estar `ACTIVE`, sem tasks pendentes
e com a quantidade esperada de tasks em execução.

Teste também a rota pública usando a URL produzida pelo Terraform:

```bash
api_url="$(terraform -chdir=apps/fullstack output -raw api_url)"
curl --fail --silent --show-error "${api_url}/health"
```

Resposta esperada:

```json
{"status":"ok"}
```

## Problemas comuns

### Credenciais expiradas

Inicie novamente o Lab e atualize o profile `default`. Enquanto a `develop`
estiver desprotegida, repita os dois comandos com
`--allow-unprotected-develop`. Depois, execute novamente somente o pipeline mais
recente.

### Job de deploy pendente

Confirme que o runner compartilhado com a tag `inteli-gitlab-runner-prd` está
online. Para os jobs de imagem, confirme também que o serviço Docker-in-Docker
iniciou e está acessível em `docker:2375`.

### Rollback não confirmado

Não inicie outro deploy. Verifique os eventos do serviço ECS, a task definition
ativa, as tasks pendentes e os logs `/ecs/view-show-api`. O comando exato para acompanhar
os logs está em
`terraform -chdir=apps/fullstack output -raw comando_logs`. Com credenciais
válidas, restaure manualmente a revisão anterior somente depois de confirmar qual
era a última revisão estável.

### Pipeline antigo na fila

Mantenha somente o pipeline mais recente. O projeto deve usar
`newest_ready_first`, impedir deploys desatualizados e manter o ambiente `aws-lab`
protegido.

### Digest da imagem diferente

Não altere a tag nem o arquivo `backend-image.env`. Confirme o SHA do commit e o
digest no ECR. Execute um novo pipeline a partir do commit correto.

### Cache de build com problema

Tente novamente primeiro. Se o cache estiver realmente corrompido, um operador
autorizado pode remover somente a imagem `buildcache` do ECR. Nunca remova imagens
identificadas pelo SHA de um commit.

## Proteções principais

- Merge requests não recebem credenciais AWS e não fazem deploy.
- Imagens, executores e ferramentas de build são fixados por versão e digest.
- O deploy valida conta, região, imagem, task definition, ALB e permissões antes
  de alterar o ECS.
- O serviço é atualizado de forma serializada.
- Falhas de estabilização ou health check acionam rollback.
- Os artefatos locais do Superpowers são ignorados pelo Git.

## Migração futura para OIDC

Quando a AWS tiver um provider OIDC do GitLab e uma role com permissões mínimas,
as três variáveis temporárias poderão ser substituídas por um ID token. O processo
de build, publicação, deploy, health check e rollback continuará igual.

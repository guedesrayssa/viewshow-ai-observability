# Deploy do backend no ECS

Este documento explica como o backend é testado, publicado no ECR e implantado
no ECS quando uma alteração é enviada para a branch `develop`.

## Como o fluxo funciona

1. Um merge request para `develop` executa os testes e valida a imagem localmente.
2. Um push de backend em `develop` executa os testes novamente.
3. O pipeline constrói a imagem `linux/amd64` usando cache.
4. A imagem é publicada no ECR com o SHA completo do commit.
5. O ECS recebe uma nova revisão da task definition.
6. O pipeline espera o serviço estabilizar e testa a rota `/health`.
7. Se algo falhar, o serviço tenta voltar para a revisão anterior.

Alterações somente em frontend ou documentação não implantam o backend.

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
- Ambiente protegido do GitLab: `aws-lab`

## Configuração inicial

### Branch e variáveis

1. Mantenha a branch `develop` protegida sempre que possível.
2. Crie as variáveis abaixo no ambiente `aws-lab`:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_SESSION_TOKEN`
3. Por padrão, marque as três como protegidas, mascaradas, ocultas e raw.

Nunca coloque credenciais AWS ou tokens do GitLab no repositório.

### Runners

O pipeline usa o runner compartilhado institucional identificado pela tag
`inteli-gitlab-runner-prd`. Os jobs de imagem usam Docker-in-Docker pela rede
interna do job, na porta `2375`, porque esse runner não compartilha certificados
TLS com o container do cliente.

## Renovação das credenciais do AWS Academy Lab

As credenciais expiram sempre que o Lab é encerrado. Depois de iniciar um novo Lab:

1. Atualize o profile local `default` da AWS CLI.
2. Confirme a conta e a role:

   ```bash
   aws sts get-caller-identity
   ```

   Registre a conta retornada para a sessão atual e confirme que a role contém
   `voclabs`. Não fixe um ID de conta no código ou no runbook: cada Learner Lab
   pode usar uma conta diferente.

3. Confirme que o `glab` está autenticado:

   ```bash
   glab auth status --hostname git.inteli.edu.br
   ```

4. Se a `develop` estiver temporariamente sem proteção, valide o modo temporário
   sem alterar o GitLab:

   ```bash
   scripts/sync-aws-gitlab-credentials.sh --dry-run --allow-unprotected-develop
   ```

5. Se a validação passar, atualize as variáveis no mesmo modo temporário:

   ```bash
   scripts/sync-aws-gitlab-credentials.sh --allow-unprotected-develop
   ```

O script atualiza somente as três variáveis AWS e não mostra seus valores. Quando
a `develop` voltar a ser protegida, execute o script sem a opção temporária para
restaurar a proteção das variáveis.

## Deploy normal

Depois que uma alteração relevante é integrada à `develop`, acompanhe estes jobs:

1. `validate_backend`: instala as dependências e executa os testes.
2. `publish_backend_image`: constrói, testa e publica a imagem no ECR.
3. `deploy_backend_ecs`: atualiza o ECS, espera a estabilização e valida `/health`.

A imagem é publicada com o SHA completo do commit e implantada por digest. Isso
evita que uma tag seja alterada depois da validação.

Somente um deploy pode executar por vez. Antes de alterar o ECS, o job também
confirma que ainda representa o commit mais recente da `develop`.

## Como verificar se funcionou

No GitLab, confirme que os três jobs terminaram com sucesso. Na AWS, o serviço
`view-show-api-service` deve estar `ACTIVE`, sem tasks pendentes e com a quantidade
esperada de tasks em execução.

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

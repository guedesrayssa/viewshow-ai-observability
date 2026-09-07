# Deploy integrado do frontend e backend na AWS com Terraform

Este guia publica o `apps/frontend` integrado ao `apps/backend/api` em uma
conta vazia do AWS Academy Learner Lab. O `apps/basica` não faz parte deste
deploy.

Não é necessário comprar ou configurar domínio. O endereço público do sistema
é o domínio HTTPS fornecido pelo Amplify.

## Resultado esperado

```text
navegador
  |
  v
AWS Amplify (HTTPS e arquivos estáticos do Next.js)
  |
  | /api/*, /auth/* e /health
  v
API Gateway (HTTPS gerenciado pela AWS)
  |
  v
Application Load Balancer (HTTP)
  |
  v
ECS Fargate :3000
  |
  v
DynamoDB
```

O navegador sempre conversa com a mesma origem do Amplify. Isso é importante
porque o backend cria a sessão com um cookie `Secure`, `HttpOnly` e
`SameSite=Lax`. O proxy evita conteúdo misto, CORS entre sites diferentes e
bloqueio do cookie.

## O que o Terraform cria

O módulo fica em `apps/infra` e cria:

| Camada | Recursos |
|---|---|
| Imagem | ECR `monitoracao-api` e imagem Docker do backend |
| Backend | cluster ECS, task definition, serviço Fargate e CloudWatch Logs |
| Rede | duas subnets públicas em AZs distintas, security groups, ALB, target group e listener |
| HTTPS | API Gateway HTTP API como terminação TLS, sem domínio próprio |
| Dados | tabelas DynamoDB `monitoracao-operacional` e `monitoracao-golden-set` |
| Frontend | app e branch no Amplify, build estático e upload do ZIP |
| Dados de demonstração | quatro incidentes e três casos no golden set |

O próprio `terraform apply` também executa:

- `docker build --platform linux/amd64`;
- login e push no ECR;
- `npm ci && npm run build` no frontend;
- compactação e publicação de `apps/frontend/out`;
- seed das tabelas DynamoDB.

## Pré-requisitos

- Terraform 1.7 ou superior;
- AWS CLI com as credenciais temporárias do Learner Lab;
- Docker com o daemon em execução;
- Node.js 18 ou superior e npm;
- acesso de rede ao ECR, npm, Docker Hub, Google Fonts e APIs da AWS.

Como as credenciais já estão no AWS CLI, basta confirmar a conta:

```bash
aws sts get-caller-identity
```

Confira o campo `Account` antes do deploy. As credenciais do Learner Lab
expiram com a sessão; se aparecer `ExpiredToken`, copie um novo bloco de
credenciais e repita o comando que falhou.

Também valide as ferramentas locais:

```bash
terraform version
node --version
npm --version
docker info
```

## Deploy completo a partir de uma conta vazia

Na raiz do repositório:

```bash
cd apps/infra
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -out=/tmp/g05.tfplan
terraform apply -input=false /tmp/g05.tfplan
```

Revise o resumo do plano antes do `apply`. Na primeira execução em uma conta
vazia, o plano deve criar recursos e não deve destruir nada.

O processo costuma levar de 8 a 15 minutos. As etapas mais demoradas são a
criação do ALB, a estabilização da task Fargate e a primeira publicação do
Amplify.

Ao terminar, o Terraform imprime os principais endereços:

```bash
terraform output painel_url
terraform output api_url_https
terraform output api_url
terraform output imagem_ecr
terraform output tabelas_dynamodb
```

Use `painel_url` para abrir o sistema. `api_url_https` é útil para Postman e
diagnóstico, mas o frontend usa as rotas da própria origem do Amplify.

Para obter o login de demonstração:

```bash
terraform output credenciais_demo
```

O valor padrão versionado é:

```text
demo@globoplay.com / demo123
```

## Como frontend e backend ficam integrados

O build do frontend recebe:

```text
NEXT_PUBLIC_API_BASE_URL=/
NEXT_PUBLIC_TELEMETRY_API_BASE_URL=/
```

Assim, no navegador, as chamadas usam o hostname atual do Amplify.

O Terraform registra três regras de proxy no Amplify:

```text
/api/<*>  -> https://<api-id>.execute-api.us-east-1.amazonaws.com/api/<*>
/auth/<*> -> https://<api-id>.execute-api.us-east-1.amazonaws.com/auth/<*>
/health   -> https://<api-id>.execute-api.us-east-1.amazonaws.com/health
```

O API Gateway encaminha método, caminho, query string, cabeçalhos, corpo e
cookies ao ALB. O ALB encaminha para a porta 3000 da task Fargate.

Na task, `FRONTEND_ORIGIN` recebe automaticamente:

```text
https://<branch>.<app-id>.amplifyapp.com
```

Nenhum certificado ACM, Route 53 ou domínio próprio é necessário.

## Testes após o deploy

Defina os endereços usando os outputs, sem copiá-los manualmente:

```bash
PAINEL_URL="$(terraform output -raw painel_url)"
API_HTTPS="$(terraform output -raw api_url_https)"
API_HTTP="$(terraform output -raw api_url)"
```

### 1. Health check do backend

```bash
curl -i "$API_HTTP/health"
curl -i "${API_HTTPS}health"
curl -i "$PAINEL_URL/health"
```

Os três devem responder `HTTP 200` e:

```json
{"status":"ok"}
```

### 2. Leitura dos dados semeados

```bash
curl -i "$PAINEL_URL/api/v1/incidents?window=24h"
```

A resposta deve ser `200` e conter os quatro incidentes de demonstração.

### 3. Login e cookie de sessão

```bash
COOKIE_JAR="$(mktemp /tmp/g05-cookie.XXXXXX)"

curl -i -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  --data '{"email":"demo@globoplay.com","password":"demo123"}' \
  "$PAINEL_URL/auth/login"
```

O resultado esperado é `HTTP 200`, corpo `{"status":"ok"}` e um cookie
`session`.

Para confirmar que a rota protegida reconhece o cookie sem alterar dados, envie
deliberadamente um status inválido:

```bash
curl -i -b "$COOKIE_JAR" \
  -X PATCH \
  -H "Content-Type: application/json" \
  --data '{"status":"invalid"}' \
  "$PAINEL_URL/api/v1/incidents/falhas-reproducao-tvs-lg/hypothesis/review"
```

O esperado é `HTTP 400` com a mensagem de validação. Se fosse `401`, o cookie
não teria atravessado o proxy ou não teria sido validado.

### 4. Teste pelo navegador

1. Abra o valor de `painel_url`.
2. Entre com o usuário de demonstração.
3. Abra Visão Geral e Incidentes.
4. No DevTools, confirme que as requisições para `/auth` e `/api` usam o
   mesmo domínio `amplifyapp.com`.
5. Confirme que não há erro de mixed content, CORS ou cookie bloqueado.

## Operação e novos deploys

Depois de alterar backend, frontend ou Terraform:

```bash
cd apps/infra
terraform plan -input=false -out=/tmp/g05.tfplan
terraform apply -input=false /tmp/g05.tfplan
```

Os hashes definidos no módulo fazem o Terraform:

- reconstruir a imagem somente quando arquivos usados pelo Docker mudarem;
- reconstruir o frontend somente quando os arquivos usados pelo painel
  mudarem;
- preservar os demais recursos quando não houve alteração.

Verifique que não ficou drift:

```bash
terraform plan -input=false -detailed-exitcode
```

Os códigos são `0` para nenhuma mudança, `2` para mudanças pendentes e `1`
para erro.

Para acompanhar o backend:

```bash
aws logs tail /ecs/monitoracao-api --follow --region us-east-1
```

Para ver o estado do serviço:

```bash
aws ecs describe-services \
  --cluster data-ingestion-cluster \
  --services monitoracao-api-service \
  --region us-east-1 \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status}'
```

## Problemas comuns

### `ExpiredToken` ou `UnrecognizedClientException`

Renove as credenciais temporárias do Learner Lab e confirme:

```bash
aws sts get-caller-identity
```

O módulo neutraliza credenciais antigas e o endpoint do DynamoDB Local que
possam existir em `apps/backend/api/.env` durante o seed. O arquivo local não
precisa ser apagado.

### ALB exige duas Availability Zones

Algumas contas do Learner Lab têm a VPC default, mas nenhuma subnet default. O
módulo cria ou adota subnets em `us-east-1a` e `us-east-1b`, então não é
necessário criá-las manualmente.

### Task ECS não estabiliza

Veja os eventos e logs:

```bash
aws ecs describe-services \
  --cluster data-ingestion-cluster \
  --services monitoracao-api-service \
  --region us-east-1 \
  --query 'services[0].events[0:10]'

aws logs tail /ecs/monitoracao-api --since 15m --region us-east-1
```

Confirme também a saúde do target group no console EC2 > Target Groups. A rota
de health check é `/health`, na porta 3000.

### Amplify abre, mas a API retorna erro

Teste na ordem:

1. `api_url/health` para ALB e ECS;
2. `api_url_https + health` para API Gateway;
3. `painel_url/health` para a regra do Amplify.

O primeiro ponto que falhar identifica a camada responsável.

### Painel abre sem dados

O dashboard consulta uma janela de 24 horas. Reexecute o seed:

```bash
cd apps/backend/api
AWS_ACCESS_KEY_ID='' \
AWS_SECRET_ACCESS_KEY='' \
AWS_SESSION_TOKEN='' \
AWS_ENDPOINT_URL_DYNAMODB='' \
AWS_REGION=us-east-1 \
OPERATIONAL_TABLE_NAME=monitoracao-operacional \
GOLDEN_SET_TABLE_NAME=monitoracao-golden-set \
npm run seed
```

## Encerramento e custo

`End Lab` não encerra automaticamente ALB e Fargate. Ao terminar a
demonstração e decidir remover a stack:

```bash
cd apps/infra
terraform plan -destroy
terraform destroy
```

`terraform destroy` remove recursos e dados. Revise o plano e só confirme
quando a equipe não precisar mais do ambiente.

## Deploy validado em 31/08/2026

Na conta de laboratório usada para validar este guia:

- `terraform apply`: concluído;
- `terraform plan` final: sem mudanças;
- frontend: `HTTP 200`;
- ALB, API Gateway e proxy do Amplify em `/health`: `HTTP 200`;
- listagem: quatro incidentes;
- login: `HTTP 200` e cookie de sessão criado;
- rota protegida com cookie: autenticação aceita.

URL publicada nesta execução:

<https://producao.d29ocp63lwy072.amplifyapp.com>

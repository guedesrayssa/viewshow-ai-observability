# Infraestrutura — View Show num AWS Academy Learner Lab

Terraform que reproduz a arquitetura entregue na Sprint 2 — ECS Fargate, ALB,
ECR, Amplify e DynamoDB — dentro do Learner Lab individual de cada pessoa, com
um `terraform apply`.

Os nomes dos recursos são os mesmos da Tabela 7 de
[`artefatos/sprint2/backend-sprint-2.md`](../../artefatos/sprint2/backend-sprint-2.md),
para que o que sobe aqui seja conferível linha a linha contra a documentação da
arquitetura.

## O que sobe

| Recurso | Nome | Arquivo |
|---|---|---|
| Repositório ECR | `monitoracao-api` | `ecr.tf` |
| Cluster ECS | `data-ingestion-cluster` | `ecs.tf` |
| Task definition (Fargate, 256/512) | `monitoracao-api-task` | `ecs.tf` |
| Serviço ECS | `monitoracao-api-service` | `ecs.tf` |
| Application Load Balancer | `data-ingestion-alb` | `alb.tf` |
| Target group (health check em `/health`) | `monitoracao-api-tg` | `alb.tf` |
| Security group do serviço | `monitoracao-api-sg` | `network.tf` |
| Log group | `/ecs/monitoracao-api` | `ecs.tf` |
| Tabelas DynamoDB | `monitoracao-operacional`, `monitoracao-golden-set` | `dynamodb.tf` |
| App Amplify (deploy manual por zip) | `g05-painel` | `amplify.tf` |
| API Gateway (só terminação TLS) | `monitoracao-api-service-tls` | `apigateway.tf` |

O Terraform também constrói e publica a imagem no ECR, compila e publica o
painel no Amplify, e semeia as tabelas — tudo dentro do `apply`.

### Duas diferenças em relação à conta compartilhada, e por quê

**O cluster e o ALB são criados aqui.** Na conta da entrega eles já existiam,
provisionados para o job de ingestão (BigQuery → DynamoDB), e a API foi
pendurada no ALB como uma regra de listener de prioridade 10, preservando a ação
padrão que servia o job. Esse job não faz parte deste repositório, então num lab
novo não há o que preservar: o ALB é criado do zero e sua ação padrão já aponta
para a API.

**Existe um API Gateway que não está no diagrama.** Ele não serve tráfego de
negócio nenhum — é só terminação TLS na frente do ALB. A razão está na próxima
seção.

## Por que o login funciona aqui e não funcionava antes

[`ci-cd-amplify.md`](../../artefatos/sprint2/ci-cd-amplify.md) registra como
limitação conhecida que o login não funciona em produção. A causa são duas
linhas em `apps/backend/api/src/routes/auth.js`:

```js
secure: process.env.NODE_ENV === "production",   // o Dockerfile crava production
sameSite: "lax",
```

Com o painel em HTTPS no Amplify e a API em HTTP no ALB, são **sites
diferentes** e **esquemas diferentes**. O navegador bloqueia a chamada por
conteúdo misto antes mesmo de sair; e se passasse, `sameSite=lax` não anexaria o
cookie. Não é um bug de código — é o desenho de duas origens que não fecha.

A correção é de infraestrutura, não de aplicação: o Amplify repassa `/api`,
`/auth` e `/health` para a API (`custom_rule` com status 200, em `amplify.tf`).
Do ponto de vista do navegador tudo sai de **uma origem só, em HTTPS**. Conteúdo
misto some, CORS some, `sameSite=lax` volta a valer e `secure=true` passa a ser
verdade.

Falta um degrau: o Amplify **recusa alvo HTTP** numa regra de proxy (`HTTP URLs
cannot be used in custom rules`), e o ALB não fala HTTPS sem certificado — que
exigiria um domínio próprio, que o laboratório não dá. O caminho natural seria
CloudFront, mas ele é **negado no AWS Academy** (`cloudfront:CreateDistribution`
→ `AccessDenied`, testado nesta conta). O API Gateway é permitido e entrega
exatamente o que falta: HTTPS com certificado válido da AWS em
`*.execute-api.amazonaws.com`, sem domínio nenhum.

A cadeia final:

```
navegador → Amplify (HTTPS) ─┬─ estáticos: painel Next.js
                             └─ /api,/auth,/health → API Gateway (HTTPS)
                                                       → ALB (HTTP)
                                                         → Fargate :3000
                                                           → DynamoDB
```

## Como funciona

O `terraform apply` faz tudo numa passada:

```
terraform apply
  │
  ├─ cria  ECR, DynamoDB x2, ALB, target group, security groups, cluster ECS
  │
  ├─ roda  scripts/publicar-imagem.mjs   constroi a API e envia ao ECR
  │
  ├─ cria  task definition + servico ECS  (puxa a imagem do ECR)
  │
  ├─ roda  npm run build                  compila o painel
  ├─ monta archive_file                   zipa out/
  ├─ roda  scripts/publicar-painel.mjs    envia o zip ao Amplify
  │
  └─ roda  npm run seed                   popula as tabelas
```

E o caminho de uma requisição no navegador:

```
navegador -> Amplify (HTTPS) -+- paginas do painel
                              +- /api, /auth, /health
                                    -> API Gateway (HTTPS)
                                       -> ALB (HTTP)
                                          -> Fargate :3000
                                             -> DynamoDB
```

### Os dois scripts em `scripts/`

O Terraform não sabe construir imagem Docker nem publicar no Amplify — essas
duas etapas precisam de comandos. Elas vivem em scripts Node, e não em comandos
de shell embutidos no `.tf`, por um motivo específico: **rodar igual no Windows**.

| Script | O que faz |
|---|---|
| `publicar-imagem.mjs` | Autentica no ECR, `docker build --platform linux/amd64`, `docker push` |
| `publicar-painel.mjs` | Envia o zip do painel ao Amplify e espera a publicação terminar |

`node arquivo.mjs` é a mesma linha nos três sistemas; um script de shell não é.
Onde deu para evitar script, foi evitado:

- o **zip** é `archive_file`, nativo do Terraform, em vez do utilitário `zip`
- o **envio** usa `fetch`, embutido no Node 18+, em vez de `curl`
- as **variáveis** vão pelo bloco `environment` do provisioner, em vez de
  `VAR=valor comando`, que é sintaxe só de shell POSIX
- os comandos encadeiam com `&&`, que funciona igual no `cmd` e no `sh`

Se você mexer nesses arquivos, mantenha essa regra — é o que faz a mesma pasta
funcionar no Linux de uma pessoa e no Windows de outra.

## Pré-requisitos

| | Para quê | Windows |
|---|---|---|
| Terraform ≥ 1.7 | rodar isto | `winget install HashiCorp.Terraform` |
| Docker, com o daemon ativo | construir a imagem da API | Docker Desktop |
| Node 18+ e `npm` | compilar o painel, rodar o seed e os dois scripts | `winget install OpenJS.NodeJS` |
| AWS CLI | credenciais e chamadas ao Amplify | `winget install Amazon.AWSCLI` |

Só isso. Não precisa de `zip`, `curl`, `bash`, WSL nem Git Bash: o zip é montado
pelo próprio Terraform e o envio usa o `fetch` embutido no Node.

O build do painel precisa de saída para `fonts.googleapis.com`: `app/layout.tsx`
usa `next/font/google`. As fontes acabam self-hosted no bundle, mas a máquina
que compila precisa alcançar o Google.

### Credenciais do Learner Lab

No AWS Academy: **AWS Details → AWS CLI**, copie o bloco e cole no arquivo de
credenciais — `~/.aws/credentials` no Linux e no macOS,
`C:\Users\<seu-usuario>\.aws\credentials` no Windows. São três linhas, e
`aws configure` **não pergunta a terceira**, então tem que ser colado à mão:

```ini
[g05-lab]
aws_access_key_id=ASIA...
aws_secret_access_key=...
aws_session_token=...
```

```bash
export AWS_PROFILE=g05-lab          # Linux/macOS
$env:AWS_PROFILE = "g05-lab"        # Windows/PowerShell
```

As credenciais expiram junto com a sessão de 4 h. Se o apply falhar com
`ExpiredToken`, recopie o bloco e rode de novo — o Terraform retoma de onde
parou.

## Uso

```bash
cd apps/infra
terraform init
terraform plan       # confira a lista antes de aplicar
terraform apply
```

Leva de **8 a 15 minutos**. O que mais demora é o ALB ficar `active` (~3 min), o
serviço ECS estabilizar atrás do health check e a publicação no Amplify.

Sem Terraform instalado, o binário é um arquivo só, sem `apt`, `brew` nem
administrador:

```bash
mkdir -p ~/.local/bin
curl -fsSL -o terraform.zip \
  https://releases.hashicorp.com/terraform/1.16.0/terraform_1.16.0_$(uname -s | tr A-Z a-z)_amd64.zip
unzip -o -q terraform.zip -d ~/.local/bin && rm terraform.zip
terraform version
```

No Windows, baixe o `.zip` da mesma página e extraia `terraform.exe` para uma
pasta do `PATH`, ou use `winget install HashiCorp.Terraform`.

## Como encontrar o link do deploy

O `apply` termina imprimindo a URL em `Outputs:`:

```
painel_url = "https://producao.d1j02paz2xgg2z.amplifyapp.com"
```

Para recuperar depois, de dentro de `apps/infra`:

```bash
terraform output painel_url
terraform output -raw painel_url    # sem aspas, para colar ou usar em script
```

Entre com `demo@globoplay.com` / `demo123` (`terraform output credenciais_demo`).

Atenção: **a URL muda a cada `terraform destroy` + `apply`**, porque o `appId` do
Amplify é novo. Ela é estável enquanto a stack existir.

## Depois do apply

```bash
terraform output api_url_https   # a API por HTTPS, para Postman
terraform output api_url         # o ALB direto, em HTTP
terraform output comando_logs    # acompanha o log da API
terraform output comando_seed    # repovoa as tabelas
```

Se o painel abrir vazio, rode o seed de novo: o `pk` de cada item é um bucket de
hora calculado na semeadura, e o dashboard consulta uma janela de 24 h — dado
com mais de ~25 h some da tela mesmo continuando na tabela. Foi o que aconteceu
em [`testes-desempenho.md`](../../artefatos/sprint2/testes-desempenho.md).

## Custo — leia antes de fechar o laboratório

O "End Lab" do AWS Academy **para instâncias EC2, e só elas**. Aqui não há EC2:
o ALB, a task Fargate e o API Gateway **continuam rodando e cobrando** depois que
você fecha o notebook. São cerca de **US$ 25/mês**, contra um orçamento total de
US$ 100 — e o indicador de gasto do lab atrasa até 8 horas, então você descobre
tarde.

```bash
terraform destroy    # ao fim de cada sessão, sem exceção
```

Isso é consequência direta da arquitetura, não desta implementação: Fargate e
ALB não têm estado "parado". Reaplicar custa os mesmos 8-15 minutos.

## Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `regiao` | `us-east-1` | O lab só permite `us-east-1` e `us-west-2` |
| `nome_cluster` | `data-ingestion-cluster` | Nome do cluster ECS |
| `nome_alb` | `data-ingestion-alb` | Nome do ALB |
| `nome_servico` | `monitoracao-api-service` | Serviço ECS |
| `nome_repositorio_ecr` | `monitoracao-api` | Repositório da imagem |
| `nome_app_amplify` | `g05-painel` | App do Amplify |
| `branch_amplify` | `producao` | Vira o subdomínio da URL |
| `cpu_task` / `memoria_task` | `256` / `512` | Igual ao `task-definition.json` |
| `quantidade_tasks` | `1` | Tasks simultâneas |
| `auth_email` / `auth_senha` | `demo@globoplay.com` / `demo123` | Login do painel |
| `permitir_dado_exemplo` | `true` | Telas que dependem da API de telemetria (fora do escopo) mostram exemplo rotulado em vez de "indisponível" |
| `semear_dados` | `true` | Roda `seed.js` no apply |
| `bedrock_habilitado` | `false` | Mantenha desligado: o lab não dá acesso ao Bedrock |
| `retencao_logs_dias` | `7` | Retenção do log group |

`AUTH_COOKIE_SECRET` não é variável: é gerado por `random_password` a cada apply,
então nunca passa pelo git. O `task-definition.json` versionado traz um
placeholder, e o código cai em silêncio para um valor conhecido se a variável
faltar — o que deixaria qualquer pessoa com o repositório forjar uma sessão.

## O que este Terraform não cobre

**A API de telemetria (Flask, `apps/basica/backend`).** Quatro das seis telas do
painel leem dela: `/eventos` e `/monitoramento` inteiras, 5 dos 6 blocos de
`/visao-geral` e 2 de 6 de `/evidencias`. Ela não tem pipeline nem nunca foi
implantada junto da API operacional. Com `permitir_dado_exemplo = true`, essas
telas mostram o conjunto de exemplo **rotulado como exemplo** na interface, em
vez de "indisponível" — comportamento previsto no próprio código
(`apps/frontend/lib/data/mode.ts`). As telas servidas pela API operacional
(`/incidentes`, `/evidencias`) mostram dado real do DynamoDB.

**O job de ingestão** (BigQuery → DynamoDB) que deu nome ao cluster e ao ALB. O
código dele não está neste repositório.

**Cognito, Secrets Manager, SQS e EventBridge**, que aparecem como decisões em
`arquitetura-inicial.md`. Nenhum tem uso no código: a autenticação é um cookie
HMAC próprio (`src/auth/session.js`), os segredos são variáveis de ambiente da
task, e não há fila nem agendador. Provisioná-los seria decoração.

## Se o apply falhar

| Erro | Causa | Conserto |
|---|---|---|
| `ExpiredToken` | Sessão do lab expirou | Recopie as credenciais e rode de novo |
| `Cannot pull container image` | Imagem não chegou ao ECR | Confira se o daemon do Docker está ativo |
| `ResourceInUseException` na tabela | Tabela já criada à mão | `terraform import aws_dynamodb_table.operacional monitoracao-operacional` |
| `exec format error` no log da task | Imagem construída em ARM (Mac M1/M2) | O `--platform linux/amd64` já está no `ecr.tf`; confira se foi alterado |
| Painel abre, dado não vem | Seed fora da janela de 24 h | `terraform output comando_seed` e rode |
| `next/font: Failed to fetch Poppins` | Build sem saída para o Google | Libere `fonts.googleapis.com` |

## Verificação

Depois do apply, esta sequência prova a cadeia inteira:

```bash
P=$(terraform output -raw painel_url)

curl -s "$P/health"                                     # {"status":"ok"} via proxy do Amplify
curl -s -o /dev/null -w '%{http_code}\n' "$P/login/"    # 200

# login devolve cookie Secure/SameSite=Lax
curl -s -i -X POST "$P/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"demo@globoplay.com","password":"demo123"}' | grep -i set-cookie

# dado real do DynamoDB
curl -s "$P/api/v1/dashboard/summary"

# rota protegida sem cookie deve dar 401
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  "$P/api/v1/incidents/falhas-reproducao-tvs-lg/hypothesis/review" \
  -H 'Content-Type: application/json' -d '{"status":"confirmed"}'
```

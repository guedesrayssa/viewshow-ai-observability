# CI/CD do painel no AWS Amplify

Roteiro do pipeline que compila o painel (`apps/frontend`) no GitLab CI e publica
o resultado no AWS Amplify Hosting, dentro do laboratório da AWS Academy.

> Documento histórico: o pipeline e seus scripts de credenciais foram removidos
> na Sprint 4. Merges não disparam publicação automática; use o provisionamento
> manual documentado no [README](../../README.md).

Região usada em tudo: **us-east-1**.

---

## Por que o build não acontece no Amplify

O Amplify Hosting conecta repositórios do GitHub, Bitbucket, GitLab.com e
CodeCommit. Este projeto vive em um GitLab **auto-hospedado**
(`git.inteli.edu.br`), que não está nessa lista. Não existe, portanto, webhook,
build automático nem preview de merge request do lado da AWS.

O caminho que sobra é o inverso: o GitLab CI compila e envia o site pronto pela
API de deployment manual do Amplify. É o que os arquivos abaixo fazem.

| Arquivo | Papel |
| --- | --- |
| Pipeline GitLab | Descontinuado na Sprint 4 |
| `apps/frontend/deploy/deploy-amplify.sh` | Empacota o `out/` e entrega ao Amplify |
| Sincronizador de credenciais GitLab | Descontinuado junto com o pipeline |

O painel é exportado como HTML estático (`output: "export"` em
`next.config.ts`). Isso é possível porque nenhuma tela usa recurso de servidor:
não há middleware, route handler nem componente de servidor que busque dados.
A consequência prática é que o app Amplify roda na plataforma `WEB`, cuja
publicação é o envio de um zip, sem runtime de computação para configurar.

---

## Preparação, feita uma vez

### 1. App e branch isolados no Amplify

O Terraform em `apps/fullstack` cria o app `view-show-painel` e a branch
`producao`, ambos com as tags de propriedade da stack. O script de publicação
resolve o identificador e o domínio pela API do Amplify em `us-east-1`; não
copie IDs ou domínios opacos para variáveis do GitLab.

### 2. Regra de 404

A exportação estática emite um `404.html`. As regras do app são declaradas em
`apps/fullstack/amplify.tf`; não atualize o app manualmente nem reutilize um ID
copiado de outra stack.

Não é preciso nenhuma regra de reescrita para as rotas normais: com
`trailingSlash: true`, cada tela vira `login/index.html`, que o Amplify serve
direto ao abrir `/login` ou recarregar a página.

### 3. Variáveis no GitLab

Em **Configurações -> CI/CD -> Variáveis**:

| Variável | Escopo | Observação |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | `aws-lab` | Credencial temporária da sessão |
| `AWS_SECRET_ACCESS_KEY` | `aws-lab` | Credencial temporária da sessão |
| `AWS_SESSION_TOKEN` | `aws-lab` | Credencial temporária da sessão |

As três variáveis devem ser protegidas, mascaradas, ocultas e `raw`. Não use o
escopo wildcard: os dois jobs `publicar:*` declaram `environment: aws-lab`, e o
GitLab entrega as credenciais somente nesse ambiente. A conta, a região, o nome
do app e a branch são bindings não secretos fixados no pipeline e novamente
validados pelo script antes do deployment.

O valor de `NEXT_PUBLIC_API_BASE_URL` entra no JavaScript durante a compilação,
não na publicação. Configurá-lo no console do Amplify não teria efeito nenhum,
porque o Amplify aqui só recebe arquivos prontos.

---

## A rotina de cada sessão do laboratório

As credenciais do laboratório continuam temporárias, mas não são mais enviadas
ao GitLab: a publicação automática foi descontinuada. Configure o profile local
da AWS CLI e execute o provisionamento manual indicado no README do projeto.

---

## Automação atual

Nenhum push, merge request ou merge dispara pipeline neste repositório. A
publicação é uma operação manual e deliberada.

---

## Publicar da máquina local

Útil para reproduzir uma falha do CI sem depurar pelo log do runner:

```bash
cd apps/frontend
npm ci
NEXT_PUBLIC_API_BASE_URL=https://<api> npm run build
./deploy/deploy-amplify.sh out
```

O comando aceita somente o app `view-show-painel`, a branch `producao`, a conta
`248880318395`, a role `voclabs` e as tags Terraform esperadas. O ID e o domínio
são resolvidos durante o preflight, sempre em `us-east-1`.

---

## Limitação conhecida: login não funciona em produção

O transporte já está resolvido: o Amplify encaminha `/api`, `/auth` e `/health`
em same-origin para o API Gateway HTTPS, que alcança o serviço da API. O painel
e as rotas operacionais não dependem de uma mudança adicional de transporte.

O login continua intencionalmente indisponível porque ainda não existe um
adaptador federado corporativo. Por isso `GET /auth/login` e
`GET /auth/callback` respondem `503 FEATURE_UNAVAILABLE`; essa resposta
fail-closed é o contrato esperado até a integração do provedor de identidade,
e não uma falha da publicação no Amplify.

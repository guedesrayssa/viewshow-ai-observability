# CI/CD do painel no AWS Amplify

Roteiro do pipeline que compila o painel (`apps/frontend`) no GitLab CI e publica
o resultado no AWS Amplify Hosting, dentro do laboratório da AWS Academy.

Região usada em tudo: **us-east-1**.

---

## Por que o build não acontece no Amplify

O Amplify Hosting conecta repositórios do GitHub, Bitbucket, GitLab.com e
CodeCommit. Este projeto vive em um GitLab **auto-hospedado**
(`git.inteli.edu.br`), que não está nessa lista. Não existe, portanto, webhook,
build automático nem preview de merge request do lado da AWS.

O caminho que sobra é o inverso: o GitLab CI compila e envia o site pronto pela
API de deployment manual do Amplify. É o que os três arquivos abaixo fazem.

| Arquivo | Papel |
| --- | --- |
| `.gitlab-ci.yml` | Valida, compila e chama a publicação |
| `apps/frontend/deploy/deploy-amplify.sh` | Empacota o `out/` e entrega ao Amplify |
| `apps/frontend/deploy/credenciais-gitlab.sh` | Renova no GitLab as credenciais da sessão |

O painel é exportado como HTML estático (`output: "export"` em
`next.config.ts`). Isso é possível porque nenhuma tela usa recurso de servidor:
não há middleware, route handler nem componente de servidor que busque dados.
A consequência prática é que o app Amplify roda na plataforma `WEB`, cuja
publicação é o envio de um zip, sem runtime de computação para configurar.

---

## Preparação, feita uma vez

### 1. Criar o app e as branches no Amplify

Sem `--repository`, justamente para que o app aceite deployments manuais:

```bash
aws amplify create-app \
    --name g05-painel \
    --platform WEB \
    --region us-east-1 \
    --query 'app.appId' --output text

aws amplify create-branch --app-id <app-id> --branch-name develop
aws amplify create-branch --app-id <app-id> --branch-name main
```

Guarde o `appId`. O domínio de cada ambiente fica
`https://<branch>.<appId>.amplifyapp.com`.

### 2. Regra de 404

A exportação estática emite um `404.html` que o Amplify só serve se mandado:

```bash
aws amplify update-app --app-id <app-id> --custom-rules \
    'source=/<*>,target=/404.html,status=404-200'
```

Não é preciso nenhuma regra de reescrita para as rotas normais: com
`trailingSlash: true`, cada tela vira `login/index.html`, que o Amplify serve
direto ao abrir `/login` ou recarregar a página.

### 3. Variáveis no GitLab

Em **Configurações -> CI/CD -> Variáveis**:

| Variável | Escopo | Observação |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | todos | Mascarada. Renovada a cada sessão |
| `AWS_SECRET_ACCESS_KEY` | todos | Mascarada. Renovada a cada sessão |
| `AWS_SESSION_TOKEN` | todos | Mascarada. Renovada a cada sessão |
| `AWS_DEFAULT_REGION` | todos | `us-east-1` |
| `AMPLIFY_APP_ID` | todos | O `appId` do passo 1 |
| `AMPLIFY_DEFAULT_DOMAIN` | todos | `<appId>.amplifyapp.com`, só para o link do ambiente |
| `NEXT_PUBLIC_API_BASE_URL` | `staging` | Endereço da API de homologação |
| `NEXT_PUBLIC_API_BASE_URL` | `producao` | Endereço da API de produção |

As duas últimas são a mesma variável com **escopo de ambiente** diferente. O
GitLab resolve qual entregar a partir do `environment:` declarado no job, o que
permite manter um endereço por ambiente sem duplicar o pipeline.

O valor de `NEXT_PUBLIC_API_BASE_URL` entra no JavaScript durante a compilação,
não na publicação. Configurá-lo no console do Amplify não teria efeito nenhum,
porque o Amplify aqui só recebe arquivos prontos.

---

## A rotina de cada sessão do laboratório

As credenciais do laboratório expiram junto com a sessão, e o pipeline passa a
falhar na publicação com erro de assinatura. Renovar leva um comando:

```bash
export GITLAB_TOKEN=<token pessoal com escopo api>
export GITLAB_PROJECT_ID=<id numérico do projeto>

# cole o bloco de "AWS Details" -> "AWS CLI" e encerre com Ctrl-D
apps/frontend/deploy/credenciais-gitlab.sh
```

Feito isso, `git push` para `develop` publica em staging sozinho.

---

## O que cada push dispara

| Evento | O que roda |
| --- | --- |
| Merge request | `lint`, `tipos`, `construir:verificacao` |
| Push em `develop` | Validação, build e publicação automática em staging |
| Push em `main` | Validação e build. A publicação em produção fica **manual** |

Produção é manual de propósito: com credenciais que expiram a cada quatro horas,
um deploy automático em `main` falharia na maior parte das vezes por motivo
nenhum ligado ao código, e o pipeline vermelho deixaria de significar algo.

Commits que não tocam `apps/frontend` não disparam nada, por conta do filtro
`changes:` no início do arquivo.

---

## Publicar da máquina local

Útil para reproduzir uma falha do CI sem depurar pelo log do runner:

```bash
cd apps/frontend
npm ci
NEXT_PUBLIC_API_BASE_URL=https://<api> npm run build
./deploy/deploy-amplify.sh <app-id> develop out
```

---

## Pendência que bloqueia o login em produção

O Amplify serve **apenas HTTPS**. A API hoje responde em `http://<ip-da-ec2>`, e
três coisas quebram por causa disso:

1. O navegador bloqueia a chamada como *mixed content* ativo, e a tela de login
   falha sem explicação visível.
2. `signIn` usa `credentials: "include"`. O cookie de sessão precisa vir com
   `SameSite=None; Secure`, e um cookie `Secure` não pode ser gravado por
   uma origem HTTP.
3. Com credenciais na requisição, o navegador rejeita
   `Access-Control-Allow-Origin: *`. A API precisa devolver a origem exata do
   painel, e não o curinga do modo padrão.

Resolver os três significa colocar a API atrás de TLS, com um nome de domínio e
um certificado do ACM, e trocar o CORS aberto por uma lista de origens
permitidas. Enquanto isso não acontece, o painel publicado sobe e navega, mas
não autentica.

# Login simples com Amazon Cognito

## Objetivo

Permitir que uma pessoa entre no View Show digitando e-mail e senha na tela de
login. O Amazon Cognito confere as credenciais e o backend cria uma sessão
segura. Nenhum segredo do Cognito fica no navegador ou no Git.

## Como funciona

1. A pessoa informa e-mail e senha no painel.
2. O frontend envia os dados por HTTPS para `POST /auth/login`.
3. O backend envia as credenciais ao Amazon Cognito.
4. Se estiverem corretas, o backend cria um cookie de sessão `HttpOnly`.
5. O frontend abre `/visao-geral`.

O navegador não armazena a senha, o client secret nem tokens do Cognito. O
client secret continua somente na task do ECS, onde o Terraform já o injeta.

## Situação atual

- User Pool: `us-east-1_ZRoG5bqCE`.
- App client: `1i7o39c3bi034gdusrd1lvqls5`.
- O User Pool e o domínio estão ativos.
- O app client aceita login por e-mail e senha.
- A API publicada já possui `POST /auth/login`.
- O frontend ainda apresenta um botão de SSO incompatível com esse fluxo.
- Existe um usuário em `FORCE_CHANGE_PASSWORD`; ele precisa receber uma senha
  permanente antes de conseguir entrar.

## Alterações no projeto

### Frontend

A tela de login terá:

- campo de e-mail;
- campo de senha;
- botão `Entrar`;
- indicador enquanto a requisição estiver em andamento;
- mensagens simples para credencial incorreta, conta pendente, excesso de
  tentativas e serviço indisponível.

O frontend chamará `POST /auth/login` com `credentials: "include"`. Em caso de
sucesso, abrirá `/visao-geral`. A senha será descartada depois da tentativa e
nunca será gravada em `localStorage` ou `sessionStorage`.

### Backend

O endpoint existente continuará autenticando no Cognito e emitindo o cookie de
sessão. A resposta deixará de enviar o ID token ao JavaScript, porque o painel
só precisa do cookie `HttpOnly`.

### Terraform e AWS

Não é necessário recriar a stack. O User Pool, o app client e as variáveis da
task ECS já existem. `terraform destroy` não será executado.

## Preparação de usuários

Cada colega deve ter a AWS CLI autenticada na mesma conta e permissão para
administrar usuários do Cognito.

### Criar um usuário novo

O comando abaixo pede o e-mail e uma senha sem gravá-los no arquivo do projeto:

```bash
read -rp "E-mail: " G05_COGNITO_EMAIL
read -rsp "Senha: " G05_COGNITO_PASSWORD
echo

aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_ZRoG5bqCE \
  --username "$G05_COGNITO_EMAIL" \
  --user-attributes Name=email,Value="$G05_COGNITO_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region us-east-1

aws cognito-idp admin-set-user-password \
  --user-pool-id us-east-1_ZRoG5bqCE \
  --username "$G05_COGNITO_EMAIL" \
  --password "$G05_COGNITO_PASSWORD" \
  --permanent \
  --region us-east-1

unset G05_COGNITO_PASSWORD
```

A senha deve ter pelo menos oito caracteres, incluindo letra maiúscula, letra
minúscula e número.

### Liberar um usuário que já existe

Se o usuário estiver em `FORCE_CHANGE_PASSWORD`, basta definir uma senha
permanente:

```bash
read -rp "E-mail: " G05_COGNITO_EMAIL
read -rsp "Nova senha: " G05_COGNITO_PASSWORD
echo

aws cognito-idp admin-set-user-password \
  --user-pool-id us-east-1_ZRoG5bqCE \
  --username "$G05_COGNITO_EMAIL" \
  --password "$G05_COGNITO_PASSWORD" \
  --permanent \
  --region us-east-1

unset G05_COGNITO_PASSWORD
```

### Confirmar que o usuário está pronto

```bash
aws cognito-idp admin-get-user \
  --user-pool-id us-east-1_ZRoG5bqCE \
  --username "$G05_COGNITO_EMAIL" \
  --region us-east-1 \
  --query UserStatus \
  --output text
```

O resultado esperado é `CONFIRMED`.

## Tratamento de erros

- Credencial incorreta: informar que o e-mail ou a senha não conferem.
- Usuário não confirmado: orientar a procurar quem administra o Cognito.
- Muitas tentativas: pedir para aguardar e tentar novamente.
- API ou Cognito indisponível: informar que o acesso está temporariamente
  indisponível.
- Erro inesperado: exibir uma mensagem genérica sem revelar detalhes internos.

## Testes e validação

- Testar a tela com credenciais corretas e incorretas.
- Confirmar que o cookie de sessão é criado e que `/auth/session` reconhece o
  usuário.
- Confirmar que a senha e o client secret não aparecem no bundle, nos logs ou
  no armazenamento do navegador.
- Executar testes, lint, verificação de tipos e build do frontend e do backend.
- Depois do deploy, validar o login pelo endereço oficial do painel.

## Fora do escopo

- SSO corporativo da Globo.
- Hosted UI do Cognito.
- Cadastro público de usuários.
- Recuperação automática de senha.
- Destruição ou recriação da infraestrutura existente.

# Login com Cognito

## O que será feito

O login terá dois campos: e-mail e senha.

1. O frontend envia o login para o backend.
2. O backend pede ao Cognito para conferir a senha.
3. Se estiver correta, o backend cria a sessão e abre o painel.

O segredo do Cognito fica somente no backend. A stack existente será mantida e
`terraform destroy` não será executado.

## Comando para cada ambiente

O User Pool muda entre contas do Learner Lab. Por isso, o comando lê o ID do
estado Terraform de cada colega, sem copiar IDs de outra conta.

Execute na raiz do repositório depois de `terraform apply`:

```bash
G05_COGNITO_POOL_ID="$(terraform -chdir=apps/fullstack output -raw cognito_user_pool_id)"
read -rp "E-mail: " G05_COGNITO_EMAIL
read -rsp "Senha: " G05_COGNITO_PASSWORD
echo

aws cognito-idp admin-create-user \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --user-attributes Name=email,Value="$G05_COGNITO_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region us-east-1

aws cognito-idp admin-set-user-password \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --password "$G05_COGNITO_PASSWORD" \
  --permanent \
  --region us-east-1

aws cognito-idp admin-get-user \
  --user-pool-id "$G05_COGNITO_POOL_ID" \
  --username "$G05_COGNITO_EMAIL" \
  --region us-east-1 \
  --query UserStatus \
  --output text

unset G05_COGNITO_PASSWORD
```

O resultado final deve ser `CONFIRMED`. A senha precisa ter no mínimo oito
caracteres, incluindo maiúscula, minúscula e número.

## Mudança no código

- Trocar o botão de SSO por campos de e-mail e senha.
- Chamar `POST /auth/login`.
- Abrir `/visao-geral` quando o login funcionar.
- Mostrar uma mensagem simples quando o login falhar.
- Não guardar senha nem token no navegador.

Os testes verificarão o login correto, credencial incorreta e indisponibilidade
do serviço.

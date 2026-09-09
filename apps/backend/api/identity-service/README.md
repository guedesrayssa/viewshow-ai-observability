# Identity Service

Emite e valida sessão assinada com expiração. Login por senha só existe no
adapter de desenvolvimento/teste quando `IDENTITY_DEV_AUTH_ENABLED=true` e as
credenciais vêm do ambiente. A flag é recusada em produção. Cadastro,
recuperação e SSO respondem `FEATURE_UNAVAILABLE` até um provider corporativo
ser integrado.

```bash
npm run build
INTERNAL_AUTH_TOKEN=... AUTH_COOKIE_SECRET=... npm run start:identity
```

Health isolado: `GET http://127.0.0.1:3003/health`.

# Runtime de compatibilidade

Supervisor temporário para a task ECS existente. Inicia gateway, incidents,
dashboard-query e identity como quatro processos Node distintos; serviços
internos escutam somente em loopback e o gateway em `0.0.0.0:3000`.

Sinais são encaminhados a todos os filhos. A morte inesperada de um processo
essencial encerra os demais e torna o container fatal.

```bash
AUTH_COOKIE_SECRET=... npm run start:compat
```

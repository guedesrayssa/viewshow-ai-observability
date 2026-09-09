# Relatório de implementação — backend TypeScript

Data: 2026-09-08.

## Implementado

- quatro processos TypeScript/Express separados e supervisor ECS compatível;
- contratos Zod/DTO e OpenAPI 3.1 público/interno;
- adapters DynamoDB Query-only com paginação completa e update condicional;
- cursor público AES-256-GCM preso ao fingerprint dos filtros;
- diagnóstico persistido sem execução agêntica e eventos ausentes explícitos;
- sessão assinada/expirável, provider fail-closed e revisão autenticada;
- gateway com CORS allowlist, Helmet, body limit, rate limit, timeout, retry de
  GET, circuit breaker, request IDs, logs JSON, OTel e métricas RED;
- frontend migrado para um gateway/envelope, sem dependência do MVP Flask;
- Docker Node 22 não-root e CI ampliado para todos os workspaces.

## Toolchain resolvida

| Componente | Versão |
| --- | --- |
| Node da imagem | 22.22.0 |
| TypeScript | 7.0.2 |
| Express | 5.2.1 |
| Zod | 4.5.4 |
| Vitest | 5.0.0 |
| AWS SDK DynamoDB | 3.1128.0 |
| OpenTelemetry Node SDK | 0.222.0 |

As versões TypeScript/Express/Zod/Vitest foram fixadas no lockfile. A imagem
Node foi mantida como exigido pela infraestrutura.

## Limitações honestas

- ingestão e projeções novas pertencem à PR futura; projeção ausente retorna
  indisponibilidade/parcialidade;
- não há fonte de evento individual;
- não há execução agêntica nem feedback funcional; apenas ports reservados;
- cadastro, recuperação e SSO aguardam provider corporativo;
- queue depth/DLQ permanecem `null`/`unknown` porque o pipeline é batch;
- o empacotamento ainda reúne processos no mesmo container por restrição do
  laboratório;
- o hash de imagem do Terraform deverá ser ampliado por uma futura PR de infra
  para rastrear mudanças isoladas nos workspaces aninhados.

## Verificação executada

- backend: formato, lint, typecheck e build aprovados; 24/24 testes Vitest e
  2/2 testes estruturais do Dockerfile aprovados;
- políticas operacionais: 165/165 testes aprovados no Node 22 Debian com a
  mesma versão de `jq` do job do GitLab;
- dependências de produção: `npm audit --omit=dev` sem vulnerabilidades
  conhecidas;
- frontend: ESLint, TypeScript, 8/8 testes Vitest e build estático das 14
  rotas aprovados;
- imagem: build `linux/amd64` aprovado, execução como usuário `node`, health
  exato `200 {"status":"ok"}` e chamada pública Gateway → Identity aprovada
  com indisponibilidade controlada `503 FEATURE_UNAVAILABLE`.

O host de desenvolvimento usa Node 24.14.1; a imagem e o CI usam o runtime
suportado Node 22.22.0.

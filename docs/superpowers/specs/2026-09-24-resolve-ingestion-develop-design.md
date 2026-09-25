# Resolver a integração de ingestion com develop

## Objetivo

Integrar `origin/develop` à branch `integration/ingestion-squash` sem perder os
endpoints e os dados canônicos do ARGUS, nem reverter os endurecimentos de
autenticação e sessão que já existem em `develop`.

## Escopo

- Resolver os 21 conflitos de merge identificados contra `origin/develop`.
- Tornar a OpenAPI o contrato único entre a API e o frontend.
- Preservar no backend as rotas e payloads de importação, sincronização ARGUS,
  eventos e evidências.
- Preservar em `develop` o login baseado em cookie HttpOnly, a não exposição de
  tokens Cognito, rate limiting específico de login e os campos de sessão
  `role` e `issuedAt`.
- Adaptar os consumidores de eventos/evidências ao contrato final, sem fallback
  silencioso para dados de demonstração.

## Resolução por camada

1. Atualizar `public.openapi.json` para descrever simultaneamente a sessão
   endurecida e os endpoints ARGUS. Testes de contrato confirmam que rotas e
   schemas do runtime e do documento continuam idênticos.
2. Integrar os handlers da API, o domínio de incidentes e o repositório DynamoDB
   a esse contrato. As mudanças de importação/ARGUS entram além das proteções de
   autenticação de `develop`, não no lugar delas.
3. Atualizar recursos e telas do frontend para os tipos do contrato final. Nos
   conflitos add/add, unir casos de teste e itens de navegação, removendo apenas
   duplicações comprovadas.
4. Conciliar o README de infraestrutura sem alterar Terraform ou executar AWS.

## Segurança e compatibilidade

O login não pode voltar a enviar tokens Cognito no corpo da resposta. A sessão
permanece no cookie HttpOnly. Os novos dados de eventos e evidências devem
manter origem, correlação e qualidade, pois esses campos são necessários para
o painel explicar dados incompletos ou não correlacionados.

## Verificação

- `npm run verify` em `apps/backend/api`;
- typecheck, testes e build em `apps/frontend`;
- testes de ingestion sem MySQL/AWS e, quando o Docker estiver disponível, os
  testes MySQL; e
- `terraform validate` em `apps/fullstack`.

Nenhuma operação de deploy, apply ou escrita em recursos AWS faz parte desta
resolução.

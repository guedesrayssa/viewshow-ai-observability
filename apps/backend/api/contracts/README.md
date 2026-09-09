# Contratos compartilhados

Pacote mínimo com Zod, DTOs, envelopes, erros, request IDs e bootstrap de
observabilidade. Não contém entidade, repository ou use case de serviço.

- `openapi/public.openapi.json`: contrato público OpenAPI 3.1.
- `openapi/internal.openapi.json`: contratos HTTP internos versionados.

Breaking changes exigem nova versão de schema e coordenação com o frontend.

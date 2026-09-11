# Documentação da infraestrutura fullstack

Este diretório centraliza a documentação técnica da IaC em Terraform
localizada em `apps/fullstack`. A documentação específica da stack local LGTM
fica em
[`../observability/documentation`](../observability/documentation/README.md).

## Artefato de entrega

- [**Infraestrutura e integração fullstack**](../../../artefatos/sprint3/infraestrutura-integracao.md):
  arquitetura atual e alvo, componentes, plano de deploy e evidências.
- [**Observabilidade local**](../observability/README.md): Docker Compose,
  configuração dos serviços e operação da stack LGTM.
- [**Mapeamentos de métricas, logs e traces**](../observability/documentation/README.md):
  contratos e roteiro de instrumentação dos três sinais.

Estado, credenciais e artefatos de execução não são versionados. A validação
local não significa que a infraestrutura foi aplicada na AWS.

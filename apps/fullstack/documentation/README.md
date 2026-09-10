# Documentação da infraestrutura fullstack

Este diretório centraliza a documentação técnica da IaC em Terraform
localizada em `apps/fullstack`. A documentação específica da stack local LGTM
fica em
[`../observability/documentation`](../observability/documentation/README.md).

## Documento canônico

- [**Infraestrutura e integração fullstack**](./infraestrutura-integracao.md):
  arquitetura, recursos, pré-requisitos, segurança, operação, validação e
  troubleshooting.
- [**Observabilidade local**](../observability/README.md): Docker Compose,
  configuração dos serviços e operação da stack LGTM.
- [**Mapeamentos de métricas, logs e traces**](../observability/documentation/README.md):
  contratos e roteiro de instrumentação dos três sinais.

Estado, credenciais e artefatos de execução não são versionados. A validação
local não significa que a infraestrutura foi aplicada na AWS.

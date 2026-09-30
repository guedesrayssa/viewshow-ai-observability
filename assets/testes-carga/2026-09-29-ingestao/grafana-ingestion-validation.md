# Evidência de provisionamento — Grafana da ingestão

- Data da validação: 30/09/2026
- Região: `us-east-1`
- Instância: `i-01002144eb3927c0d`
- Dashboard: `View Show — Ingestão`
- UID: `view-show-ingestion`
- Data source: `cloudwatch`

## Resultado

O bootstrap terminou com o marcador `PROVISIONED`; os containers Grafana,
Prometheus, Loki, Tempo e Alloy foram iniciados e o arquivo
`view-show-ingestion.json` estava presente no diretório de provisioning.

A API local do Grafana respondeu:

```text
database: ok
version: 13.2.1
dashboard uid: view-show-ingestion
CloudWatch metrics API: successfully queried
CloudWatch logs API: successfully queried
```

A consulta foi executada internamente por AWS Systems Manager, sem expor o
Grafana à internet. Nenhuma credencial ou senha foi preservada nesta evidência.

## Validações locais associadas

- configuração Terraform válida;
- template renderizado como JSON válido;
- 8 painéis, com IDs de painel e `refId` únicos;
- todos os painéis usam o data source `cloudwatch`;
- provisionamento AWS isolado em 1 criação da EC2, sem alteração da API ou das
  tasks de ingestão.

Uma captura visual do dashboard com a janela do benchmark selecionada ainda
deve ser coletada pelo túnel SSM para compor a evidência de apresentação.

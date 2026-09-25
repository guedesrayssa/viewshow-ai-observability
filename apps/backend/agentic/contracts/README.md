# Contratos executáveis do Worker de Análise

Os arquivos em `fixtures/` são exemplos canônicos, versionados e sem dados
reais. Eles congelam a fronteira entre ingestão, API e Worker de Análise:

- `anomaly-detection.v1.json`: janela fechada de 15 minutos;
- `qoe-forecast.v1.json`: janela horária e a próxima hora prevista;
- `reanalysis-requested.v1.json`: pedido humano de nova investigação;
- `time-series-fact.v1.json`: item mínimo que o leitor aceita no DynamoDB.
- `ingestion-facts.v1.json` e `ingestion-events.v1.json`: o que o código da ingestão
  grava (itens tipados do DynamoDB) e publica (corpo das mensagens SQS). São gerados
  por `apps/backend/ingestion-data/tests/contracts/test_worker_contract.py`; depois de
  uma mudança deliberada, regenere com `UPDATE_CONTRACT_FIXTURES=1` e rode
  `ingestion-contract.test.ts`.

Os testes `contract-fixtures.test.ts` e `ingestion-contract.test.ts` validam os eventos com o mesmo parser usado
em produção e valida o fato por meio do adaptador DynamoDB. Mudanças
incompatíveis exigem uma nova versão; não se edita silenciosamente uma fixture
já compartilhada.

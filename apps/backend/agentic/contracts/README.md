# Contratos executáveis do Worker de Análise

Os arquivos em `fixtures/` são exemplos canônicos, versionados e sem dados
reais. Eles congelam a fronteira entre ingestão, API e Worker de Análise:

- `anomaly-detection.v1.json`: janela fechada de 15 minutos;
- `qoe-forecast.v1.json`: janela horária e a próxima hora prevista;
- `reanalysis-requested.v1.json`: pedido humano de nova investigação;
- `time-series-fact.v1.json`: item mínimo que o leitor aceita no DynamoDB.

O teste `contract-fixtures.test.ts` valida os eventos com o mesmo parser usado
em produção e valida o fato por meio do adaptador DynamoDB. Mudanças
incompatíveis exigem uma nova versão; não se edita silenciosamente uma fixture
já compartilhada.

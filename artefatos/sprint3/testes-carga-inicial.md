# Testes de carga — movido

&emsp; Este arquivo deixou de ser o artefato de entrega. O documento canônico de
testes de carga e observabilidade é:

### → [`artefatos/testes-carga-inicial.md`](../testes-carga-inicial.md)

&emsp; A consolidação de 11 de setembro de 2026 reuniu naquele arquivo, tomando
`origin/develop` (`238ccec`) como referência auditada:

- a matriz revisada dos quinze requisitos não funcionais (RNF01 a RNF15), com
  plano de teste, ferramenta, critério, ambiente necessário, evidência e status;
- os cenários obrigatórios de 10 mil eventos/minuto, fila cheia e timeout, nos
  termos da arquitetura atual e da arquitetura anterior;
- os resultados executados contra a API TypeScript (`apps/backend/api`), com os
  resumos JSON brutos em [`assets/testes-carga/2026-09-11/`](../../assets/testes-carga/2026-09-11/README.md);
- os resultados históricos da API Flask (`apps/basica/backend`) e da rodada AWS
  do schema v1, identificados como evidência de arquitetura anterior;
- a observabilidade dos quatro indicadores (latência p95, throughput, erros por
  segundo e CPU), com capturas do Grafana e as séries do Prometheus.

&emsp; Duas versões completas com resultados divergentes no repositório foram o
problema que a consolidação resolveu — por isso este arquivo não guarda mais
conteúdo próprio. Se você chegou aqui por um link antigo, siga para o documento
canônico acima.

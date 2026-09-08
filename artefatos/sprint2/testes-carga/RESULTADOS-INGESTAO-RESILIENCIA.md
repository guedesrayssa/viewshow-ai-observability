# Resultados de carga e resiliência — API de ingestão

> Evidência local controlada, executada em 6 de setembro de 2026. Este relatório
> não representa uma medição de capacidade da infraestrutura AWS.

## Resumo executivo

A API Flask de ingestão sustentou a taxa configurada de **10.000 eventos por
minuto** no backend em memória. A rodada nominal aceitou 10.100 eventos em
aproximadamente 60 s, com p95 de 2,89 ms, 100% dos checks e nenhuma iteração
descartada.

Nas duas rodadas de resiliência, a API respondeu com o contrato explícito
durante a falha induzida e voltou ao patamar nominal sem reinício:

- fila cheia: 100% dos checks de falha confirmaram HTTP 429 e
  `error.code=queue_full`; a recuperação aceitou 10.000 eventos com p95 de
  2,93 ms;
- timeout: 100% dos checks de falha confirmaram HTTP 504 e
  `error.code=dependency_timeout`; a recuperação aceitou 10.100 eventos com
  p95 de 2,68 ms.

O resultado comprova o contrato, a não persistência do lote recusado (coberta
também por teste automatizado) e a recuperação da API local. Não comprova
saturação ou recuperação de uma fila real, escalonamento do worker nem o tempo
ponta a ponta até os dados aparecerem na API de consulta.

## Rastreabilidade dos critérios da entrega

| Critério | Evidência nesta branch | Situação |
| --- | --- | --- |
| (1) RNFs e planos revisados, 10 mil eventos/min, fila cheia e timeout | RNF01/RNF02/RNF03 em [`../../sprint1/requisitos.md`](../../sprint1/requisitos.md), cenários e thresholds em [`k6/ingestao-resiliencia.js`](k6/ingestao-resiliencia.js), contrato de falhas coberto pelos testes do backend | **Cumprido no escopo executável local**; fila/worker reais continuam como etapa de staging declarada |
| (2) Resultados com análise de desempenho e resiliência | Três resumos JSON, tabela de resultados e análises nas seções abaixo | **Cumprido para a API local**; não deve ser apresentado como resultado de produção/AWS |

## Ambiente e método

| Item | Configuração |
| --- | --- |
| Host | Linux 7.1.8 x86_64 |
| Gerador | k6 v2.2.0, imagem `grafana/k6@sha256:5221b620a4f874faff6e32ba597aa667c058391fe4898b1c6f6377f062c6cdec` |
| Aplicação | Python 3.14.7, Gunicorn 26.0.0 |
| Servidor | 1 processo, 8 threads, `127.0.0.1:18080` |
| Persistência | `TELEMETRY_BACKEND=memory`, teto de 200.000 registros |
| Carga | modelo aberto, 100 lotes/min, 100 eventos/lote |
| Payload | telemetria sintética sem dados pessoais, identificador único por evento |
| Timeout induzido | 250 ms |

O pré-voo exigiu HTTP 200 de `/v1/analytics/realtime/overview`. As falhas foram
habilitadas somente durante a execução, protegidas por token e desligadas ao
encerrar o servidor.

## Critérios

| Fase | Critério de aprovação |
| --- | --- |
| Nominal | ≥ 10.000 eventos aceitos/min, HTTP 202 e lote integral em 100% dos checks, erro < 1%, p95 < 2 s, zero descarte |
| Falha | 100% das respostas com status e código esperados: 429/`queue_full` ou 504/`dependency_timeout` |
| Recuperação | ≥ 10.000 eventos aceitos/min, 100% dos checks, p95 < 2 s, zero descarte |

Respostas 429 e 504 foram marcadas como esperadas no k6 para não inflar
`http_req_failed`; os checks de fase são o critério que reprova um status ou
código incorreto.

## Resultados

| Cenário | Eventos tentados | Eventos aceitos | Recusa esperada | Checks | Erro HTTP inesperado | Descartes | p95 nominal | p95 recuperação | Resultado |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Carga | 10.100 | 10.100 | — | 202/202 | 0% | 0 | 2,89 ms | — | **Passou** |
| Fila cheia | 20.100 | 15.000 | 5.100 | 402/402 | 0% | 0 | 2,95 ms | 2,93 ms | **Passou** |
| Timeout | 20.100 | 15.100 | 5.000 | 402/402 | 0% | 0 | 2,85 ms | 2,68 ms | **Passou** |

O executor foi configurado para 100 lotes por minuto. O k6 iniciou uma iteração
na fronteira final em duas rodadas, produzindo 10.100 em vez de 10.000 eventos;
isso é 1% acima, não abaixo, do patamar exigido. O threshold usa `>= 10.000`
para tratar corretamente essa borda.

Arquivos brutos exportados pela própria ferramenta:

- [`resultados/resumo-ingestao-carga-local.json`](resultados/resumo-ingestao-carga-local.json)
- [`resultados/resumo-ingestao-fila-cheia-local.json`](resultados/resumo-ingestao-fila-cheia-local.json)
- [`resultados/resumo-ingestao-timeout-local.json`](resultados/resumo-ingestao-timeout-local.json)

## Análise de desempenho

O p95 nominal permaneceu entre 2,85 e 2,95 ms nas três execuções, muito abaixo
do limite de 2 s usado para a confirmação da ingestão. Nenhuma iteração foi
descartada, portanto o gerador conseguiu manter a taxa solicitada. O backend em
memória, o tráfego em loopback e a carga relativamente baixa em requisições
(1,67 lote/s) explicam a latência curta; o volume alto está dentro de cada lote.

Esses números demonstram que validação, parsing e armazenamento em memória não
saturaram nesse host. Eles não devem ser projetados para DynamoDB ou para a AWS,
onde rede, capacidade de escrita, partições e número de processos alteram o
resultado.

## Análise de resiliência

Durante fila cheia, os lotes foram recusados rapidamente e de forma observável,
com 429, em vez de serem aceitos e perdidos silenciosamente. Durante timeout, o
p95 global subiu para 251,36 ms, consistente com o atraso induzido de 250 ms, e
as chamadas terminaram com 504 explícito. Os testes unitários confirmam que os
dois caminhos não persistem o lote.

Depois de retirar cada falha, o mesmo processo voltou imediatamente à taxa
nominal, sem erros, descarte ou reinício. A latência de recuperação não ficou
degradada: 2,93 ms após fila cheia e 2,68 ms após timeout.

## Limitações e pendências para homologação

1. Fila cheia e timeout são respostas controladas na borda da API; não há SQS
   nem dependência saturada nesta execução.
2. Não foram medidos retry com backoff do emissor, DLQ, idade/profundidade da
   fila, duplicação, ordenação nem perda depois de uma confirmação 202.
3. O backend em memória não representa throughput, throttling, paginação ou
   latência do DynamoDB.
4. RNF02 exige acompanhar um identificador da entrada até a consulta em no
   máximo 120 s; esta execução mede apenas a confirmação HTTP.
5. A rodada de consulta na AWS documentada em
   [`../testes-desempenho.md`](../testes-desempenho.md) é anterior à correção de
   chaves. Os cenários pesados pós-correção continuam pendentes.

Assim, a branch entrega uma **evidência local aprovada** para o patamar de 10
mil eventos/minuto e para o comportamento/recovery das falhas simuladas. A
validação integral dos RNF01/RNF02/RNF03 em produção ou staging permanece
pendente até existir e ser exercitada a cadeia real de fila, worker e banco.

## Reprodução

O roteiro completo está no
[`README.md`](README.md#ingestão-10-mil-eventosminuto-e-falhas-controladas) e a
bateria automatizada em [`k6/rodadas-ingestao.sh`](k6/rodadas-ingestao.sh).
Os thresholds vivem no próprio
[`k6/ingestao-resiliencia.js`](k6/ingestao-resiliencia.js), fazendo a execução
terminar com status diferente de zero quando um critério é violado.

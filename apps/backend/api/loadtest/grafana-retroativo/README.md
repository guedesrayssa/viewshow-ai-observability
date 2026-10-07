# Grafana retrospectivo: visualizações dos testes já realizados

Esta stack reabre medições preservadas sem AWS, credenciais de laboratório ou
cluster ativo. Não executa nova carga e não preenche intervalos sem observação.
Grafana usa seu datasource Prometheus para consultar um leitor de evidências;
esse leitor implementa apenas endpoints HTTP necessários à visualização e
aceita nomes exatos de séries. Não avalia PromQL e não é um servidor Prometheus.
Os quatro indicadores EKS foram calculados pelo Prometheus real durante o teste;
esta stack apenas devolve os pares timestamp/valor guardados nos arquivos.

## Arquivos e correspondência

| Arquivo | Responsabilidade |
| --- | --- |
| `build.py` | Lê frames EKS, etapas/recursos ECS e métricas SQS; gera séries/dashboards e proveniência com hashes |
| `series.json` | Pares timestamp/valor, unidade, transformação e arquivo de origem por série |
| `replay.py` | API HTTP de leitura, sem interpolação e sem avaliação de expressões arbitrárias |
| `compose.yml` | Python 3.12.11, Grafana 13.2.1 e renderer 3.12.9; montagens read-only; portas loopback |
| `provisioning/datasources/replay.yml` | Datasource UID `rnf-retro`, endpoint interno `http://replay:8080` |
| `provisioning/dashboards/provider.yml` | Provisiona dashboards em “Evidências preservadas” |
| `provisioning/dashboards/rnf-retro-api.json` | p95, req/s, 5xx/s e CPU EKS em % de um núcleo; quatro painéis |
| `provisioning/dashboards/rnf-retro-ingestao.json` | Duração e vazão por etapa, CPU e memória ECS; quatro painéis |
| `provisioning/dashboards/rnf-retro-fila.json` | Visíveis/em processamento, idade, recebimentos/confirmações e DLQ; quatro painéis |
| `render.mjs` | Consulta cada expressão via Grafana, exige amostras e exporta PNG nativo; preserva respostas e vereditos |

## Reprodução na raiz do repositório

Requer Python ≥3.10 (biblioteca padrão), Node 22 e Docker Compose.

```bash
python3 apps/backend/api/loadtest/grafana-retroativo/build.py
docker compose -f apps/backend/api/loadtest/grafana-retroativo/compose.yml up -d
curl -f http://127.0.0.1:13003/api/health
node apps/backend/api/loadtest/grafana-retroativo/render.mjs
```

Abra http://127.0.0.1:13003; usuário `lab`, senha local `local-rnf-only`.
Os dashboards possuem suas janelas UTC fixadas. O replay fica em
`127.0.0.1:19092`; Grafana em `127.0.0.1:13003`. A porta não conflita com
o laboratório de coleta em 13002. O renderer não publica porta no host.

Os resultados vão para
[`assets/testes-carga/2026-10-07-revisao/`](../../../../../assets/testes-carga/2026-10-07-revisao/):
`grafana-api.png`, `grafana-ingestao.png`, `grafana-fila.png`, respostas de
painéis, validação por expressão e `provenance.json`. Se uma fonte mudar,
seu novo hash ficará no manifesto; nunca tratar a exportação como nova medição.

## Semântica e limites

- EKS: cópia dos frames finais, inclusive CPU corrigida em percentual de um núcleo.
  Throughput/5xx são do servidor coletado; k6 conta também timeouts e erros externos.
- Ingestão: `StageDurationMs/1000` e `150000*60/duração` são pontos de fim de etapa,
  exibidos sem linha interpolada. Não representam p95 nem taxa instantânea.
  CPU/memória copiam percentuais CloudWatch. Rejeitados=0 é agregado da rodada,
  não uma série temporal completa de erros/s do worker.
- Fila: bucket original CloudWatch, sem converter recebimentos em taxas não medidas.
  Idade é segundos; mensagens são lotes de 150 mil, não eventos individuais.
- O gate valida todas as expressões dos painéis (inclusive duas séries quando
  existentes). Zero vale apenas quando está presente no arquivo de origem.

Para remover somente os containers retrospectivos:

```bash
docker compose -f apps/backend/api/loadtest/grafana-retroativo/compose.yml down
```

Os arquivos de evidência continuam no repositório. Esta stack não usa IAM,
não muda dados da aplicação e não cria recursos AWS.

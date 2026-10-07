# Revisão de apresentação e análise — 07/10/2026

Este complemento atende ao feedback do MR !101. **Nenhuma carga nova foi
executada nesta revisão.** As figuras são exportações nativas do Grafana sobre
medições previamente coletadas. Os arquivos de origem permanecem preservados.

| Figura | Origem e janela UTC | Semântica |
| --- | --- | --- |
| `grafana-api.png` | EKS `observability-load137-final/prometheus-panel-1..4.json`, 07/10 02:04:45–02:10:45 | p95 HTTP, throughput servido, 5xx/s vistos pela API e CPU corrigida em % de um núcleo; 73 amostras por indicador |
| `grafana-ingestao.png` | ECS `2026-10-04-ingestao/etapas-cg05-150000.json` e `cloudwatch-recursos-cg05-150000.json`, 04/10 19:46:30–20:24:31 | Durations e vazão N/tempo de etapa são pontos agregados; CPU/memória são séries CloudWatch; não inventa erros/s do worker |
| `grafana-fila.png` | `2026-10-05-ingestao/sqs-rs01-3lotes.json`, 06/10 02:30–03:05 | Profundidade, idade, recebimentos/confirmações por bucket e DLQ; cada mensagem representa 150 mil eventos |

O [manifesto de proveniência](provenance.json) identifica hash, transformação,
unidade e quantidade de amostras. Respostas de cada painel estão em
`grafana-*-panel-*.json`; os três gates estão em `grafana-*-validation.json` e
a validação de todas as 18 expressões em
[observability-validation.json](observability-validation.json).

[performance-analysis.json](performance-analysis.json) preserva a conta da
taxa sequencial, os tempos, a diferença para o k6 e a contagem usada no cálculo.

As medidas calculadas são explícitas: `StageDurationMs/1000` e
`150000*60/duração`. A CPU EKS usa os frames finais da consulta corrigida;
os valores percentuais ECS são os percentuais já preservados no CloudWatch.
Não há preenchimento de lacunas, deslocamento temporal ou geração de zeros.

## Correspondência com o feedback

| Itens | Correção e localização no artefato principal |
| --- | --- |
| 1–2 | Seções/subseções em ordem; unidades na seção 5.1 e alertas na 4.3 |
| 3–4 | Texto explica os termos ao usá-los; inventário completo movido para anexo técnico |
| 5–8 | Antes→agora; perfis com taxa/rampa/volume/prazo; fila cheia definida como backlog; catálogo RS-01..06 e CT-02 na seção 3 |
| 9–12 | Resultado consolidado, taxas/tempos por etapa, recuperação por falha e cadeia de colapso ECS/EKS na seção 4 |
| 13–17 | Três capturas novas criadas e embutidas, original EKS embutido com ressalva de CPU, leitura dos gráficos, cobertura por ambiente e reprodução em `grafana-retroativo/` |
| 18–19 | Estado de cada decisão, RS-06/proxy e alarme por idade da fila na seção 6 |

Três ajustes evitam repetir imprecisões do feedback ou da primeira entrega:

- Os 0,58 s, ~130 s e ~5,5 min são variantes do **RS-02**, não do RS-05.
- A taxa sequencial é `1/(1/r1+1/r2+1/r3)`, não a média harmônica convencional.
  Há folga de CPU agregada, mas ARCHIVING chega a ocupar um núcleo de duas vCPUs.
- O erro do ACTIVE sintético foi diagnosticado/removido antes do nominal EKS;
  ele não comprova a causa da não conclusão dessa rodada posterior.

## Reprodução

Consulte o [README da stack](../../../apps/backend/api/loadtest/grafana-retroativo/README.md)
e o [artefato principal](../../../artefatos/testes-carga-finais.md).
As fontes de carga são históricas; datas, contas e digests não foram reatribuídos.

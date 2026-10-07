# Visualizações retrospectivas da ingestão — revisão de 06/10/2026

Estas imagens foram geradas dos brutos versionados. Não houve nova execução de carga na AWS;
não são capturas de Grafana e não substituem uma captura desse painel com dados da mesma rodada.

| Figura | Fontes | Método |
| --- | --- | --- |
| `indicadores-controle.png` | `2026-09-30-ingestao/resumo-ingestao-{cg01,cg04,rs06}.json` e `cloudwatch-recursos-{cg01,api-cg04,api-rs06}.json` | p95 HTTP e req/s do k6; `http_req_failed.passes * http_reqs.rate / http_reqs.count` para falhas/s médias; CPU máxima utilizado/reservado. CG-01 inclui PUT S3 e CPU do worker; demais, CPU da API |
| `recursos-cg05.png` | `2026-10-04-ingestao/etapas-cg05-{150000,300000}.json` e `cloudwatch-recursos-cg05-{150000,300000}.json` | Duração em minutos por etapa; séries de CPU/memória utilizadas divididas pela reserva; minutos desde o início de cada rodada |
| `fila-rs01-4lotes.png` | `2026-10-05-ingestao/sqs-rs01-4lotes.json` e marco da agenda em `rs01-4lotes-execucao.txt` | Séries AWS/SQS por minuto: visíveis, em processamento, DLQ e idade; timestamps convertidos para UTC |

Reprodução, na raiz, em Python com matplotlib:

```bash
python apps/backend/api/loadtest/scripts/render-ingestion-evidence.py
```

Ausências de amostras não são preenchidas com zero. O gráfico de controle agrega rodadas
com durações diferentes; não simula uma série temporal. O relatório está em
[Testes de Carga e Resiliência da Ingestão](../../../artefatos/sprint5/testes-carga-ingestao.md).

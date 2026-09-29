# Evidências locais da observabilidade da ingestão — 29/09/2026

## Ambiente

- revisão do repositório: `e9fb599`;
- Python: `3.12.11`, executado em container descartável;
- imagem: `python:3.12.11-slim-bookworm`, fixada pelo mesmo digest usado no
  `Dockerfile` da ingestão;
- execução local, sem conta AWS e sem dashboard Grafana;
- horário dos relatórios: UTC, conforme os arquivos JUnit.

## Resultados válidos

| Verificação | Escopo | Resultado | Duração registrada | Evidência |
| --- | --- | ---: | ---: | --- |
| Observabilidade | adaptador CloudWatch/EMF, logs JSON, runtime observado, redaction e contrato OpenTelemetry legado | 47 aprovados, 0 falhas, 0 erros, 0 ignorados | 0,840 s | [`pytest-observabilidade.xml`](pytest-observabilidade.xml) |
| Resiliência incremental | adapters S3/SQS, CLI incremental, retomada de exportação e retomada de ingestão | 25 aprovados, 0 falhas, 0 erros, 0 ignorados | 1,274 s | [`pytest-resiliencia-incremental.xml`](pytest-resiliencia-incremental.xml) |
| Geração da massa de carga | fixture determinística equivalente a 10 mil registros/min durante 15 min | 150.000 registros gerados; 917.703 bytes comprimidos | não medida pelo gerador | [`manifest-150k.json`](manifest-150k.json) |

Total das suítes automatizadas: **72 testes aprovados**, sem falhas, erros ou
testes ignorados. Os tempos acima são tempos do pytest dentro do container e não
representam latência ou capacidade do pipeline de produção.

O snapshot de 150 mil registros possui SHA-256
`21069cb588d937f5174275112c47d790a3eb18fa4648ac190a53cd6136feee15`.
Ele foi mantido em `.artifacts/argus-benchmarks/150k/argus_dump.sql.gz`, fora das
evidências versionáveis por ser massa intermediária regenerável.

## Limitações da rodada

- O host não possuía Python 3.12 nem AWS CLI; por isso os testes foram executados
  no container oficial e não houve consulta a CloudWatch.
- O benchmark do leitor não foi classificado como executado. Seu harness chama
  `docker compose` internamente, mas o Python 3.12 estava disponível apenas no
  container. Expor o socket administrativo do Docker ao container foi evitado.
- A geração da massa comprova volume e determinismo, não throughput, latência,
  CPU, fila cheia ou timeout do pipeline completo.
- Os cenários de 10 mil eventos/min, fila cheia e timeout continuam pendentes no
  ambiente AWS controlado. As capturas do Grafana dependem da tarefa seguinte.

## Comandos lógicos executados

As suítes foram executadas com `PYTHONPATH=src` no container Python 3.12:

```text
pytest tests/unit/adapters/test_telemetry.py tests/test_observability.py

pytest tests/unit/adapters/test_incremental_s3.py
       tests/unit/adapters/test_incremental_sqs.py
       tests/integration/test_incremental_cli.py
       tests/resilience/test_incremental_export_resume.py
       tests/resilience/test_incremental_ingest_resume.py
```

A massa foi criada por `scripts/build_benchmark_snapshot.py` com `--rows 150000`,
`--snapshot-extracted-on 2026-09-29` e `--variant baseline`.

# Task 6 — Experiência QoE

## Entregas

- Implementado `dump_explorer.qoe` com leituras agregadas de player, dispositivo,
  UF × ISP, QoE live, sessões ativas e categorias de erro.
- Gerado `analysis/notebooks/04_experiencia_qoe.ipynb`, sem outputs nem contagens
  de execução.
- Adicionados gráficos de impacto, categorias, UF × ISP e série temporal de QoE.

## Garantias aplicadas

- Todas as consultas temporais usam parâmetros e a janela UTC `[start, end)`.
- Leituras continuam protegidas pelo limite global de 100.000 linhas; não há consulta
  nem coluna de identificador individual.
- Taxa de erro é nula quando `sessions = 0`; `(desconhecido)` e outros valores
  ausentes são marcados explicitamente.
- `device_hourly` aplica `min_sessions` no `HAVING` SQL antes do ranking.
- QoE live preserva ratio, segundos e milissegundos; live e VOD não são misturados.
- Sessões ativas são rotuladas como concorrentes; `top_names` preserva texto bruto
  com flag de erro para JSON inválido.
- A geografia usa heatmap UF × ISP local, sem ativos externos.
- O notebook contextualiza o atraso estrutural de aproximadamente 28 horas ao lado
  do timestamp NPAW mais recente.

## Verificação

- RED observado para `tests/test_qoe.py`: `ModuleNotFoundError:
  dump_explorer.qoe`.
- RED observado para o notebook 04: `ValueError: Notebook não suportado: 04`.
- GREEN: `.venv/bin/python -m pytest tests/test_notebook_builder.py
  tests/test_qoe.py tests/test_charts.py -v` — 29 passed.
- Geração: `.venv/bin/python scripts/build_notebooks.py 04` — notebook criado
  sem outputs.

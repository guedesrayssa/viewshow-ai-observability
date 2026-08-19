# Task 8 — Eventos ao vivo e notebook 06

Implementado:

- `event_key` como identidade de confronto e `tid` preservado como identidade de feed.
- Leitura de slots EPG completos por sobreposição de intervalo `[start, end)`.
- Alinhamento de audiência/QoE de 15 minutos, com 60 minutos de contexto configurável.
- Mapeamento exato de sinais, exceto `globo%`, marcado como
  `national_family_approximation`.
- Agregação ponderada pela audiência para a família Globo e slots EPG sem telemetria
  preservados com `telemetry_available=False`.
- Notebook `06_eventos_ao_vivo.ipynb` com catálogo EPG, audiência antes/durante/depois,
  erros, buffering, join time e comparação de confrontos.

Verificação executada:

```text
pytest tests/test_live.py tests/test_notebook_builder.py -v  # 13 passed
ruff check src/dump_explorer/live.py src/dump_explorer/charts.py scripts/build_notebooks.py tests/test_live.py tests/test_notebook_builder.py  # All checks passed
python scripts/build_notebooks.py 06  # notebook generated without outputs
git diff --check  # passed
```

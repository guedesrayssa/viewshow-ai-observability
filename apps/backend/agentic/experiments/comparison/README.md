# Comparação prospectiva A′ / B / C / autocorreção

Laboratório separado do A/B anterior e do worker de produção. Bibliotecas: Python padrão. Reutiliza consultas e cliente Ollama de `../ab/benchmark.py`, cujo hash também é congelado. O [protocolo de pesquisa](../../../../../artefatos/arquitetura/estudos/protocolo-comparacao-final.md) define amostragem, rubrica e decisão.

## Fluxo

1. `prepare.py` reserva oito datas novas a partir da extração SQLite; produz calibração separada com os casos antigos 03/05/09. Recusa sobrescrever a reserva.
2. `runner.py --phase calibration` roda os três casos conhecidos nas quatro configurações, com uma repetição. Ajustes só aqui; falhas não são substituídas.
3. `runner.py --phase evaluation --calibration ...` exige calibração completa, válida e com o mesmo código/modelo. Congela manifesto e roda 96 resultados. `--limit N` permite lote parcial retomável.
4. `evaluate.py packets` gera fichas anônimas e `review.html` após o plano completo. Não sobrescreve fichas existentes.
5. O usuário preenche e exporta avaliações no HTML. `evaluate.py summary --reviews arquivo.json` calcula comparação descritiva, incluindo falhas, sem dar notas automaticamente.

No shell, a partir da raiz do repositório:

```bash
python3 -m unittest discover -s apps/backend/agentic/experiments/comparison -p 'test_*.py' -v
python3 apps/backend/agentic/experiments/comparison/prepare.py --source /tmp/viewshow-final-qoe.sqlite --prior artefatos/arquitetura/estudos/resultados/2026-09-21-ab-real-72/dataset.json --output artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-input
python3 -u apps/backend/agentic/experiments/comparison/runner.py --phase calibration --dataset artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-input/calibration.json --output artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-calibration-v3
```

Depois de calibrar sem falhas, preservar os arquivos. Conferir a reserva antes de abrir a avaliação:

```bash
python3 -u apps/backend/agentic/experiments/comparison/runner.py --phase evaluation --dataset artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-input/evaluation.json --calibration artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-calibration-v3 --output artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-final-v1
python3 apps/backend/agentic/experiments/comparison/evaluate.py packets artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-final-v1
python3 apps/backend/agentic/experiments/comparison/evaluate.py summary artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-final-v1
python3 apps/backend/agentic/experiments/comparison/evaluate.py summary artefatos/arquitetura/estudos/resultados/2026-09-22-comparison-final-v1 --reviews /caminho/avaliacoes-viewshow.json
```

O túnel padrão é `http://127.0.0.1:11435`. Os pedidos enviam QoE agregada e nomes de canais ao Ollama da faculdade; não enviam o dump completo. O processo termina antes de gerar execuções se o serviço não estiver acessível.

As calibrações v1 e v2 foram preservadas com suas falhas. A v3 concluiu 12/12 resultados válidos e é a base da avaliação. Os comandos acima retomam os diretórios existentes sem substituir resultados; uma mudança de código exige novos diretórios e nova calibração. A reserva já existe e não deve ser recriada por conveniência.

## Invariantes

- B gera uma base única por caso/seed; C e autocorreção compartilham a mesma base e evidências, sem novos dados. O hash da base é registrado.
- C e autocorreção usam contextos isolados idênticos, exceto o papel descrito; isso testa uma forma limitada de revisão, não um supervisor autônomo.
- Custos do rascunho contam em cada configuração revisada, enquanto chamadas efetivamente novas também são identificadas.
- Contexto obrigatório inclui definições, comparação do alvo e denominadores calculados sobre horas pareadas.
- Hipóteses podem ser vazias; observações exigem evidências recebidas. IDs de origem sem valores expostos não ficam citáveis automaticamente.
- Dados posteriores ao corte, horas incompletas, divisão por zero, ferramentas arbitrárias, truncamentos e excessos de orçamento são tratados explicitamente.
- Fichas não incluem rótulo da configuração. A chave é separada; o conteúdo ainda pode sugerir o método. Não abrir a chave antes de avaliar.
- A nota humana é necessária para comparação de qualidade. O resumo sem avaliações contém somente medidas operacionais.

`protocol.json` mantém as escolhas de amostra, recursos de decisão e rubrica. Alterações após calibração exigem nova calibração antes de abrir a avaliação. Depois de consultar resultados finais para fazer ajustes, os casos passam a ser desenvolvimento.

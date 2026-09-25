# Laboratório de investigação A/B

Protótipos experimentais em Python, sem dependências externas. Não alteram o worker nem a biblioteca TypeScript. O modelo roda no Ollama do servidor; consultas e coordenação executam localmente sobre recortes congelados.

## Protótipos

- **A:** catálogo, comparação fixa da métrica-alvo e até duas métricas auxiliares, leitura da série-alvo, uma chamada para diagnóstico.
- **B:** mesmo catálogo inicial, até duas consultas escolhidas pelo modelo e diagnóstico. Usa chamadas nativas de ferramentas do Ollama; não simula escolha do agente com regras fixas.

Os dois usam o mesmo prompt de diagnóstico, modelo, recorte, seed por repetição e teto de orçamento. A versão atual usa um prompt experimental próprio, não é idêntica ao `investigate()`/`rca-v2` da primeira rodada. O catálogo conta como uma das três consultas. O A pode não gastar todo o orçamento disponível; registrar custo efetivo é parte da comparação.

### Protocolo proposto de 72 execuções

12 cenários × 2 protótipos × 3 repetições. Seeds 41, 42 e 43, temperatura 0,2, raciocínio desativado explicitamente, contexto de 16.384 tokens. Até três chamadas ao LLM, três consultas contando o catálogo, 2.000 tokens gerados por chamada, 6.000 por investigação e 240 segundos por investigação. Cada requisição tem até 120 segundos, limitada pelo tempo restante.

Também se limita a entrada serializada a 30.000 bytes por chamada e 90.000 bytes acumulados. Bytes não são tokens. O consumo efetivo de entrada em tokens é registrado quando fornecido pelo servidor. A latência medida inclui o transporte pelo túnel; o envelope do Ollama também preserva os tempos de carga e inferência.

O prompt e os limites podem ser ajustados **no desenvolvimento**. Depois da criação do manifesto de uma bateria, o executor rejeita retomada se código, prompt, dataset, modelo ou parâmetros mudarem. Os resultados de cada investigação são gravados atomicamente. Retomar não repete os arquivos já concluídos, inclusive falhas; novas tentativas devem usar outra rodada e ser relatadas separadamente.

## Dados e limitações

`development.json` é um caso sintético reservado a integração e ajuste; não entra nas 72 execuções. O caminho dos dados reais será usado para preparar a bateria principal. Não converter esse caso em suposta evidência operacional.

Cada caso no dataset contém `id`, `synthetic`, `cutoff`, `signal`, `reference_window`, `current_window` e `records`. Cada registro possui `id`, `timestamp`, `metric`, `scope`, `value`, `unit` e `source`. Janelas têm `start`, `end` exclusivo e `expected_points`. O sinal deve registrar como foi obtido; sinal simulado ou indicador exploratório não pode ser descrito como saída de modelo treinado.

As ferramentas filtram registros posteriores ao corte; gabaritos não fazem parte das entradas. Registros ausentes ficam ausentes. Comparações informam cobertura e média não ponderada dos pontos disponíveis. Taxas agregadas que precisem de ponderação por sessões exigem um preparo específico dos dados, não uma interpretação automática dessa média.

As hipóteses são validadas quanto à estrutura e aos IDs efetivamente consultados. Isso não verifica a verdade da explicação. Ausência de métricas adicionais deve aparecer como indisponibilidade; nem o modelo nem a ferramenta devem inventar uma fonte.

## Execução

Na raiz do repositório, com o túnel SSH na porta 11435:

```bash
python3 -m unittest discover -s apps/backend/agentic/experiments/ab -p 'test_*.py' -v
python3 -u apps/backend/agentic/experiments/ab/benchmark.py --dataset apps/backend/agentic/experiments/ab/development.json --output /tmp/viewshow-ab-development --repetitions 1
```

Para a bateria, usar um dataset preparado com 12 casos e um diretório de resultados novo. O padrão é três repetições; `--limit` permite um lote parcial retomável sem alterar o plano completo. Nunca usar o diretório de desenvolvimento para a comparação final.

```bash
python3 -u apps/backend/agentic/experiments/ab/benchmark.py --dataset /caminho/dataset-congelado.json --output /caminho/resultados-da-bateria
python3 apps/backend/agentic/experiments/ab/summarize.py /caminho/resultados-da-bateria
```

O relatório não atribui notas de qualidade automaticamente. As fichas ocultam o nome do protótipo; sua chave fica em arquivo separado. A geração preserva fichas já existentes para não apagar avaliações humanas. Gerar as fichas finais após concluir a bateria; fichas parciais existentes devem ser preservadas/renomeadas antes de gerar um conjunto maior.

Referência de integração: [API de chat](https://docs.ollama.com/api/chat) e [chamadas de ferramentas](https://docs.ollama.com/capabilities/tool-calling) do Ollama, consultadas em 21/09/2026.

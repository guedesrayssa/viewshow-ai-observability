# Evidências dos testes de carga

Brutos (JSON do k6, sumários, métricas) das execuções de carga do projeto. A análise de cada uma está
nos documentos de `artefatos/`; as pastas abaixo guardam só o que foi medido e as condições da medição.

| Pasta | Data | O que é | Status | Documento |
| --- | --- | --- | --- | --- |
| [`2026-10-05-frontend/`](2026-10-05-frontend/README.md) | 05/10/2026 | Exportação estática atual: Autocannon (smoke, carga, pico e recuperação), Lighthouse móvel/desktop e smoke comparativo do Amplify | **Vigente para o frontend da branch** | [Testes de Carga Finais](../../artefatos/testes-carga-finais.md) |
| [`2026-10-01-aws-gerador-na-regiao/`](2026-10-01-aws-gerador-na-regiao/README.md) | 01/10/2026 | `front-api.js` revisado na AWS (tarefa de 0,25 vCPU), k6 dentro da VPC, com métricas de CloudWatch | **Vigente** | [Testes de Carga da API](../../artefatos/sprint5/testes-de-carga-da-api.md) |
| [`2026-09-30-local/`](2026-09-30-local/README.md) | 30/09/2026 | Experimentos locais e emulação da tarefa: volume de dados, controles negativos, limitador de taxa | Complementar | [Testes de Carga da API](../../artefatos/sprint5/testes-de-carga-da-api.md) |
| [`2026-09-30-aws-gerador-externo/`](2026-09-30-aws-gerador-externo/README.md) | 30/09/2026 | Primeira rodada do `front-api.js` na AWS (script original, k6 fora da região) e suas erratas | Histórica | [Testes de Carga da API](../../artefatos/sprint5/testes-de-carga-da-api.md) |
| [`2026-09-11-aws/`](2026-09-11-aws/README.md) | 11/09/2026 | `consultas.js` em ECS Fargate de 1 vCPU, k6 fora da AWS | Histórica | [Sprint 3](../../artefatos/sprint3/testes-carga-inicial.md) |
| [`2026-09-11/`](2026-09-11/README.md) | 11/09/2026 | `consultas.js`, `auth-check.js` e `ingestao-batch.js` em leito local, com Prometheus e Grafana | Histórica | [Sprint 3](../../artefatos/sprint3/testes-carga-inicial.md) |
| `01-*.png` a `04-*.png` | Sprint 2 | Capturas da suíte da Sprint 2 (k6 na EC2, CPU saturada) | Histórica | [Sprint 2](../../artefatos/sprint2/testes-desempenho.md) |

"Histórica" quer dizer que a execução usou outro script, outra arquitetura ou outra configuração e não
representa a API atual; os resultados continuam válidos para o que mediram, não para a capacidade de hoje.

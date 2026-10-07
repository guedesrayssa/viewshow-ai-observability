# Aplicação final da Sprint 5

**Vídeo da Sprint 5:** [Demonstração View Show](https://youtu.be/ngVQchG-JEM)

**Duração:** 6min18s (link não listado, conferido em 07/10/2026).

Trechos: Docker e healthcheck (0:24–1:20); Kubernetes, autorrecuperação,
escala manual, rollout interrompido e rollback (1:22–3:25); componentes em
Compose e comunicação por fila/tabela (3:26–5:19); Pods/Job e DLQ (5:20–6:18).

O [artefato técnico completo](sprint5/aplicacao-final.md) documenta a arquitetura
distribuída, os Dockerfiles e filtros de build, a correspondência dos arquivos
Terraform/Helm com os recursos Kubernetes, a execução AWS e os limites medidos.
A infraestrutura está em [apps/fullstack](../apps/fullstack/README.md); o chart,
renderer e comandos operacionais estão em [apps/kubernetes](../apps/kubernetes/README.md).

| Item avaliado | Peso | Evidência e estado |
| --- | ---: | --- |
| Execução em Docker | 2 | Três Dockerfiles com bases fixadas, healthcheck e execução demonstrados no vídeo |
| Orquestração Kubernetes | 4 | Manifests/infraestrutura versionados; vídeo mostra implantação, autorrecuperação, rollout bloqueado e rollback em cluster local |
| Componentes em contêineres | 4 | API, Worker e ingestão executados em Compose e depois como Pods/Job; evento publicado, processado e resultado verificado |

As falhas provocadas, os resultados de recuperação e os quatro indicadores
estão no [relatório de carga e observabilidade](testes-carga-finais.md).
O [runbook de recuperação](../apps/kubernetes/RECUPERACAO.md) inclui probes,
progresso dos workers, retenção/visibilidade das filas e reconciliação de dados.
A [matriz dos apontamentos da Sprint 4](apoio/revisao-feedback-sprint4.md)
relaciona descontos, correções, evidências e pendências de comprovação.

Não há aprovação end-to-end das metas de capacidade no EKS: ingestão nominal
e API-137 reprovaram nas execuções preservadas. O vídeo usa um ambiente local
isolado (ElasticMQ, DynamoDB Local e MySQL) para demonstrar o fluxo funcional;
isso está separado das evidências de capacidade e da implantação AWS.

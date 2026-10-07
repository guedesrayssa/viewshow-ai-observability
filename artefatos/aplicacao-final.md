# Aplicação final da Sprint 5

**Vídeo: em gravação.** Ainda faltam o link acessível e a duração verificada
de 5 a 7 minutos. Este status será atualizado quando a gravação for entregue.

O [artefato técnico completo](sprint5/aplicacao-final.md) documenta a arquitetura
distribuída, os Dockerfiles e filtros de build, a correspondência dos arquivos
Terraform/Helm com os recursos Kubernetes, a execução AWS e os limites medidos.
A infraestrutura está em [apps/fullstack](../apps/fullstack/README.md); o chart,
renderer e comandos operacionais estão em [apps/kubernetes](../apps/kubernetes/README.md).

| Item avaliado | Peso | Evidência e estado |
| --- | ---: | --- |
| Execução em Docker | 2 | Três Dockerfiles com bases fixadas e escolhas explicadas; gravação da execução pendente |
| Orquestração Kubernetes | 4 | Implementação Terraform/Helm e evidências nativas EKS existentes; demonstração da revisão final em vídeo pendente |
| Componentes em contêineres | 4 | API e ingestão com evidências AWS; fluxo completo incluindo análise da revisão final ainda precisa ser demonstrado |

As falhas provocadas, os resultados de recuperação e os quatro indicadores
estão no [relatório de carga e observabilidade](testes-carga-finais.md).
O [runbook de recuperação](../apps/kubernetes/RECUPERACAO.md) inclui probes,
progresso dos workers, retenção/visibilidade das filas e reconciliação de dados.
A [matriz dos apontamentos da Sprint 4](apoio/revisao-feedback-sprint4.md)
relaciona descontos, correções, evidências e pendências de comprovação.

Não há aprovação end-to-end das metas de capacidade no EKS: ingestão nominal
e API-137 reprovaram nas execuções preservadas. A gravação deve mostrar o
comportamento efetivo e a recuperação, sem apresentar uma proposta como execução.

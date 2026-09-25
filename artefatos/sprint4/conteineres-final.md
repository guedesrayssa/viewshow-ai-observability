# Conteinerização Final

> Este artefato apresenta a aplicação View Show com foco na arquitetura distribuída, na conteinerização dos componentes e na orquestração por Kubernetes. O vídeo demonstra como a API, o Worker de Análise e a Ingestão de Dados podem ser executados em contêineres Docker e implantados no cenário de referência com Amazon EKS e AWS Fargate.

## Sumário

1. [Vídeo da arquitetura final e conteinerização](#1-vídeo-da-arquitetura-final-e-conteinerização)
2. [Conteúdo apresentado](#2-conteúdo-apresentado)
3. [Referências no repositório](#3-referências-no-repositório)

---

## 1. Vídeo da arquitetura final e conteinerização

<div align="center">

<strong>Vídeo: Arquitetura final e conteinerização do View Show</strong>

[Assista ao vídeo no Google Drive](https://drive.google.com/file/d/1_gQzaGmxubH-4ijJGH1vknx1Xj3HnDsw/view?usp=sharing)

</div>

&emsp;O vídeo apresenta o fluxo de implantação desde a construção das imagens Docker até a execução dos workloads em Kubernetes. O Amazon EKS é apresentado como cenário arquitetural de referência; a implantação operacional atual do projeto permanece em Amazon ECS com AWS Fargate, conforme descrito em [Arquitetura Final](./arquitetura-final.md).

## 2. Conteúdo apresentado

| Item | Demonstração no vídeo |
| --- | --- |
| Conteinerização com Docker | Apresenta os Dockerfiles da API, do Worker de Análise e da Ingestão de Dados, destacando o empacotamento isolado de cada componente. |
| Orquestração com Kubernetes | Mostra como os componentes poderiam ser descritos por `Deployment`, `Service`, `CronJob` e `Ingress` no Amazon EKS com AWS Fargate. |
| Execução dos componentes | Explica a execução independente da API, da ingestão periódica e do Worker, incluindo comunicação assíncrona pela SQS, escalabilidade e monitoramento. |
| Resiliência | Aborda probes de saúde, escalonamento da API, acionamento do Worker conforme a fila, DLQ e possibilidade de retorno a uma versão anterior das imagens e manifests. |

&emsp;A proposta separa os ciclos de execução dos serviços: a API atende às requisições do dashboard, a Ingestão de Dados processa as janelas programadas e o Worker de Análise consome as solicitações assíncronas. Essa divisão permite aplicar permissões, recursos e políticas de escala apropriados a cada workload.

## 3. Referências no repositório

- [Dockerfile da API](../../apps/backend/api/Dockerfile)
- [Dockerfile do Worker de Análise](../../apps/backend/agentic/Dockerfile)
- [Dockerfile da Ingestão de Dados](../../apps/backend/ingestion-data/Dockerfile)
- [Configuração Docker Compose da observabilidade](../../apps/fullstack/docker-compose.observability.yml)
- [Documento de arquitetura final](./arquitetura-final.md)

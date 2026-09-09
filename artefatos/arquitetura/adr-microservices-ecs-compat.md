# ADR — microsserviços em processos separados na unidade ECS existente

- Estado: aceito
- Data: 2026-09-08

## Contexto e contradições

Documentos históricos descrevem um MVP Flask e o documento sistêmico de
ingestão registra um “monólito modular Python”. O contrato atual exige backend
operacional TypeScript em microsserviços reais, mas proíbe alterar Terraform ou
provisionar novos recursos AWS.

A precedência aplicada foi: prompt de implementação; fronteiras/read models do
documento de ingestão; contrato público do dashboard; contrato DynamoDB; gaps;
infraestrutura existente; frontend; documentos históricos. Portanto, o desenho
Python histórico não define o backend operacional vigente.

## Decisão

Gateway, Incident Service, Dashboard Query Service e Identity Service são
executáveis e processos Node separados, com portas, configuração, health e
composição próprios. Toda comunicação entre eles é HTTP versionado. Apenas
schemas/DTOs/observabilidade são compartilhados; implementações e memória não.

O container ECS existente usa `runtime-compat` como supervisor. Os três
serviços internos escutam em loopback; somente o gateway escuta em
`0.0.0.0:3000`. `dumb-init` recebe sinais, o supervisor os encaminha e a morte
de um filho essencial torna a unidade fatal.

## Consequências

- ECR, cluster, ECS Service/task family/container, ALB, API Gateway, tabelas e
  Amplify permanecem iguais; `apps/infra` não é alterado.
- Há acoplamento temporário de implantação, não de código ou processo.
- Cada serviço pode migrar depois para imagem/container/ECS Service próprio sem
  mudar o contrato interno.
- O contexto Docker continua `apps/backend/api`, por isso os workspaces ficam
  aninhados nele. O hash Terraform histórico não enumera os novos diretórios;
  a mudança atual no Dockerfile força a imagem desta entrega e o GitLab CI usa
  glob amplo. Uma PR futura de infraestrutura deve ampliar esse hash antes de
  depender de `terraform apply` para mudanças isoladas nos serviços.
- Variáveis legadas de usuário/senha da task são ignoradas. Sem provider real,
  Identity falha fechado em produção; isso é dívida de configuração, não
  autorização para senha local.

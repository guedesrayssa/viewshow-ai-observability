# Design: provisionamento e acesso idempotente ao Grafana no Learner Lab

## Objetivo

Permitir que uma única execução do comando abaixo garanta a existência da
infraestrutura de observabilidade e entregue o acesso ao Grafana:

```bash
node apps/scripts/aws-learner-lab.mjs grafana
```

Se a infraestrutura não existir, o comando deve criar somente os recursos de
observabilidade aprovados. Se ela já existir, não deve gerar uma alteração
Terraform desnecessária. Nos dois casos, deve validar a saúde do Grafana,
informar URL, usuário e senha e abrir o túnel privado pelo Session Manager.

A configuração do Ollama é opcional. Sua ausência não pode transformar uma
implantação saudável do Grafana em falha.

## Estratégia de integração entre os MRs

O comando `grafana`, o gate protegido de observabilidade e os utilitários de
túnel estão no MR 96. O dashboard de ingestão e seus reparos estão no MR 90.
Para evitar copiar a implementação do MR 96 para o MR 90, a integração deve
seguir esta ordem:

1. integrar o MR 96 em `develop`;
2. atualizar a branch do MR 90 com o novo `develop` em uma worktree isolada;
3. resolver os conflitos preservando os dashboards Agentic e Ingestão;
4. implementar no MR 90 a extensão idempotente do comando `grafana`;
5. validar o resultado combinado antes de atualizar a branch remota do MR 90.

Os conflitos conhecidos estão em:

- `apps/fullstack/observability-aws.tf`;
- `apps/fullstack/observability/aws/user-data.sh.tftpl`;
- `apps/fullstack/observability/aws/validate-user-data.sh`.

A resolução deve manter os dois templates, os dois arquivos provisionados no
Grafana e o payload EC2 comprimido com `user_data_base64`.

## Interface pública

O comando não receberá uma flag obrigatória:

```bash
node apps/scripts/aws-learner-lab.mjs grafana
```

O comportamento será idempotente:

- observabilidade ausente: planejar, validar, confirmar e aplicar;
- observabilidade existente e saudável: não aplicar Terraform;
- observabilidade existente e não saudável: diagnosticar e falhar sem substituir
  automaticamente a EC2;
- após uma implantação ou reutilização saudável: exibir as credenciais e abrir
  o túnel SSM em `http://localhost:3002`.

O comando existente `grafana --senha` continuará disponível para consultar
somente a senha sem provisionar nem abrir o túnel.

## Fluxo de provisionamento

1. Validar checkout, região, profile AWS, credenciais, Terraform, AWS CLI e
   Session Manager.
2. Inicializar o Terraform no workspace `default` e validar o state local e
   remoto usando os controles já existentes.
3. Consultar o output `observabilidade_instancia_id` e o endpoint OTLP para
   determinar se a observabilidade está provisionada.
4. Quando ausente, gerar um plano salvo com:
   - `observabilidade_habilitada=true`;
   - worker de análise desabilitado;
   - exportação da API desabilitada durante essa preparação isolada;
   - nenhum CIDR público para o Grafana.
5. Validar o plano com o gate de observabilidade do MR 96. O gate deve aceitar
   somente EC2 de observabilidade, security group, regras privadas aprovadas e
   senha aleatória do Grafana. Exclusão isolada, ingress público e alteração da
   aplicação são proibidos.
6. Exibir o resumo e exigir a confirmação exata antes do `terraform apply`.
7. Aplicar exclusivamente o arquivo de plano já validado e protegido contra
   substituição.
8. Aguardar a instância aparecer no SSM, o `cloud-init` concluir e o Grafana
   responder saudável.

Uma instância existente não será substituída automaticamente em caso de falha.
Como os dados da pilha ficam em volumes Docker locais à EC2, uma substituição
automática poderia apagar evidências e histórico.

## Validação funcional do Grafana

Antes de anunciar sucesso, o comando deve verificar por SSM ou pelo túnel:

- `/api/health` com banco `ok`;
- data source CloudWatch saudável;
- dashboard `view-show-ingestion` presente;
- dashboard Agentic presente quando fizer parte do checkout integrado;
- containers Grafana, Prometheus, Loki, Tempo e Alloy em execução.

Depois das verificações, deve ler os outputs Terraform validados, imprimir o
resumo e iniciar o túnel SSM. `Ctrl+C` encerra somente o túnel.

## Credenciais e saída

Em terminal interativo, a saída de sucesso terá o formato:

```text
Infraestrutura: CREATED | EXISTING
Grafana:        READY
CloudWatch:     READY
Dashboard:      view-show-ingestion
URL:            http://localhost:3002
Usuário:        admin
Senha:          <valor de grafana_senha>
Ollama/LLM:     CONFIGURED | NOT_CONFIGURED
```

A senha deve ser lida exclusivamente do output sensível `grafana_senha`. Ela
não pode aparecer em logs de diagnóstico, evidências versionadas ou saída não
interativa. Sem TTY, o comando informa que a senha foi omitida e orienta o uso
interativo de `grafana --senha`.

## Ollama como capacidade opcional

O estado do Ollama é independente da saúde do Grafana:

- `CONFIGURED`: model ID registrado no manifest operacional; este estado não
  afirma conectividade;
- `NOT_CONFIGURED`: configuração ausente; estado informativo e exit code zero.

O comando `grafana` não deve ativar o worker, testar inferência nem criar a
ponte SSH. Essas responsabilidades continuam em `analysis-bridge`,
`analysis-check`, `analysis-smoke` e `analysis-activate`. Se um comando que
explicitamente exige LLM não encontrar o Ollama, ele continua falhando.
Somente `analysis-check` e `analysis-smoke` podem afirmar conectividade com o
endpoint; `grafana` não deve apresentar `READY` para o Ollama.

## Tratamento de erros

- Plano rejeitado: não confirmar e não aplicar.
- Confirmação recusada: não aplicar e não abrir o túnel.
- Falha de `apply`: preservar o erro primário e limpar somente artefatos cuja
  identidade permaneça validada.
- SSM indisponível, `cloud-init` incompleto, container parado, Grafana ou
  CloudWatch não saudável: retornar erro sem imprimir credenciais.
- Infraestrutura existente não saudável: não gerar substituição automática.
- Ollama ausente: informar `NOT_CONFIGURED` e continuar.

## Testes

### Testes automatizados do CLI

- `grafana` provisiona observabilidade ausente com plano protegido;
- plano rejeitado ou confirmação recusada nunca chega ao `apply`;
- observabilidade existente não executa `terraform plan` ou `apply`;
- instância não saudável não é substituída;
- sucesso imprime URL e usuário e abre o túnel nas plataformas suportadas;
- senha aparece somente em TTY e nunca em erros;
- Ollama ausente produz `NOT_CONFIGURED` e exit code zero;
- `grafana --senha` preserva o comportamento de consulta isolada;
- o gate recusa deletes, recursos extras, ingress público e valores desconhecidos.

### Testes do dashboard e bootstrap

- renderer standalone sem placeholders residuais;
- payload comprimido dentro do limite de 16 KiB;
- dashboards Agentic e Ingestão presentes no `user_data`;
- template de ingestão é JSON válido após renderização;
- IDs de painel e `refId` únicos;
- expressões CloudWatch usam período fixo e dimensões corretas.

### Validação integrada

- executar as suítes do Learner Lab com `--test-concurrency=1`;
- executar os testes do gate de análise/observabilidade;
- executar `terraform fmt -check -recursive`, `terraform validate` e os testes
  Terraform relevantes;
- comparar o resultado com um baseline limpo de `develop`;
- provisionar no Learner Lab;
- confirmar saúde dos cinco containers, CloudWatch e ambos os dashboards;
- abrir o Grafana pelo comando e validar URL e credenciais;
- registrar Ollama ausente como limitação opcional, sem reprovar o Grafana.

## Critério de conclusão

O MR 90 estará pronto para teste quando o comando `grafana` puder partir de uma
stack fullstack sem observabilidade, criar somente a pilha privada aprovada,
validar o dashboard de ingestão, entregar acesso e credenciais, e retornar
sucesso mesmo sem Ollama. O mesmo comando, repetido, deve reutilizar a pilha sem
nova alteração Terraform.

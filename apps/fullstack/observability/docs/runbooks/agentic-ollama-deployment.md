# Rollout do worker Agentic com Ollama

Este runbook valida a integração em duas etapas: primeiro localmente, depois no
AWS Academy Learner Lab. Não registre endpoint privado, credenciais, corpo de
mensagem, entrada/saída do modelo ou logs completos nas evidências.

## Gate local

Execute da raiz do repositório.

- [ ] Subir a observabilidade e confirmar que os containers estão saudáveis:

  ```bash
  docker compose -f apps/fullstack/docker-compose.observability.yml up -d
  docker compose -f apps/fullstack/docker-compose.observability.yml ps
  ```

- [ ] Em outro terminal, abrir o túnel interativo. Informe usuário, host e senha
  apenas no terminal; não grave esses valores no shell history ou em arquivo:

  ```bash
  read -r -p "SSH user: " OLLAMA_SSH_USER
  read -r -p "SSH host: " OLLAMA_SSH_HOST
  ssh -N -L 11434:127.0.0.1:11434 "${OLLAMA_SSH_USER}@${OLLAMA_SSH_HOST}"
  ```

- [ ] Em um terceiro terminal, selecionar um modelo anunciado pelo servidor e
  executar o check de conectividade:

  ```bash
  export OLLAMA_BASE_URL=http://127.0.0.1:11434
  export LLM_MODEL_ID="$(curl --fail --silent "$OLLAMA_BASE_URL/api/tags" | jq -er '.models[0].name')"
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4320
  export OTEL_SERVICE_NAME=view-show-agentic
  export OTEL_DEPLOYMENT_ENVIRONMENT=local
  export OTEL_SERVICE_VERSION="$(git rev-parse --short HEAD)"
  (cd apps/backend/agentic && npm run check:ollama-connectivity)
  ```

- [ ] Executar o smoke real Ollama → OTLP, capturando a saída sanitizada em um
  diretório privado. O smoke envia `PROMPT_SMOKE_SENTINEL`, exige que a resposta
  contenha `RESPONSE_SMOKE_SENTINEL` e não imprime nenhum dos dois:

  ```bash
  umask 077
  SMOKE_EVIDENCE_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$SMOKE_EVIDENCE_DIR"' EXIT HUP INT TERM
  (cd apps/backend/agentic && npm run smoke:ollama-observability) \
    >"$SMOKE_EVIDENCE_DIR/stdout.log" 2>&1
  SMOKE_TRACE_ID="$(jq -Rr \
    'fromjson? | select(.event == "ollama_observability_smoke") | .trace_id' \
    "$SMOKE_EVIDENCE_DIR/stdout.log" | tail -n 1)"
  printf '%s' "$SMOKE_TRACE_ID" | grep -Eq '^[a-f0-9]{32}$'
  ```

- [ ] Confirmar no Prometheus que existem séries agregadas do LLM:

  ```bash
  curl --fail --get http://127.0.0.1:9090/api/v1/query \
    --data-urlencode 'query=sum(llm_requests_total)'
  curl --fail --get http://127.0.0.1:9090/api/v1/query \
    --data-urlencode 'query=sum(rate(llm_request_duration_seconds_count[5m]))'
  ```

- [ ] Abrir o Tempo no Grafana, localizar `llm.generate` e confirmar a relação
  `analysis.message → llm.generate`. A árvore também é exigida pelo teste
  `instrumented-llm-provider.test.ts`.

- [ ] Abrir o dashboard `view-show-agentic` no Grafana e conferir outcomes,
  p50/p95/p99, tokens, stop reasons e traces.

- [ ] Baixar o trace completo do Tempo e procurar os marcadores tanto na saída
  capturada quanto no payload bruto, cobrindo atributos e eventos sem presumir
  seus nomes. Registrar exatamente `0 ocorrências`; não copie o payload para a
  evidência:

  ```bash
  curl --fail --silent "http://127.0.0.1:3200/api/traces/$SMOKE_TRACE_ID" \
    >"$SMOKE_EVIDENCE_DIR/trace.json"
  if grep -Eq 'PROMPT_SMOKE_SENTINEL|RESPONSE_SMOKE_SENTINEL' \
    "$SMOKE_EVIDENCE_DIR/stdout.log" "$SMOKE_EVIDENCE_DIR/trace.json"; then
    echo "falha: conteúdo do smoke vazou para observabilidade" >&2
    exit 1
  fi
  echo "0 ocorrências"
  ```

## Ponte SSH temporária para a validação AWS

Esta opção usa o bastion existente como endpoint privado do Ollama para o ECS.
O notebook mantém dois túneis: um até o Ollama institucional e outro, reverso,
até o bastion pela sessão SSM. O notebook precisa permanecer ligado durante
`analysis-check`, `analysis-smoke`, `analysis-activate` e `analysis-canary`.
Não coloque SSH ou credenciais na task ECS.

1. Com credenciais AWS ativas, obtenha o ID e o IP privado do bastion no
   checkout físico que contém o state Terraform:

   ```bash
   BASTION_ID="$(terraform -chdir=apps/fullstack output -json bastion_acesso | jq -er '.instancia_id')"
   BASTION_PRIVATE_IP="$(aws ec2 describe-instances --instance-ids "$BASTION_ID" --region us-east-1 --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
   export VIEW_SHOW_OLLAMA_BASE_URL="http://${BASTION_PRIVATE_IP}:11434"
   ```

2. Abra uma sessão SSM no bastion com
   `aws ssm start-session --target "$BASTION_ID" --region us-east-1`. Em
   `/etc/ssh/sshd_config.d/90-view-show-ollama-bridge.conf`, configure
   `GatewayPorts clientspecified` e `PermitListen <IP_PRIVADO_DO_BASTION>:11434`.
   Valide com `sudo sshd -t` e recarregue com `sudo systemctl reload sshd`.
   Confira também `sudo sshd -T` para confirmar que `gatewayports` e
   `permitlisten` estão efetivos antes de abrir o túnel.
   O endereço permitido deve ser exatamente `BASTION_PRIVATE_IP`. A regra
   Terraform abre TCP 11434 no Security Group do bastion somente para o
   Security Group do serviço ECS quando `--ssh-bridge` está ativo.

3. Execute `analysis-prepare` abaixo com o bundle de validação local, o
   catálogo e o modelo instalado no Ollama. Passe `--ssh-bridge` ao comando:
   ele cria o worker com zero réplicas e a regra restrita da ponte. O comando
   guarda essa escolha no manifesto local para ativação e desativação.

4. Em um terminal do notebook, abra os três túneis com o facilitador
   multiplataforma. Ele pergunta o usuário/host do Ollama e o caminho da chave
   `vockey` sem gravá-los; a senha do Ollama continua sendo solicitada pelo SSH:

   ```bash
   node apps/scripts/aws-learner-lab.mjs analysis-bridge
   ```

   Mantenha o processo aberto. Ele exibe o endpoint privado do bastion; exporte
   esse valor em `VIEW_SHOW_OLLAMA_BASE_URL` no terminal de ativação. Em Windows,
   use PowerShell ou Prompt de Comando com os clientes `ssh`, AWS CLI v2 e Session
   Manager Plugin instalados.

5. Confirme `/api/tags` pelo IP privado dentro do bastion e depois execute
   `analysis-check`. Se a conexão SSH cair, interrompa a ativação e deixe o
   worker em zero réplicas. Ao terminar o canário, execute
   `analysis-deactivate` antes de fechar os túneis. A regra da ponte permanece
   gerenciada pelo Terraform até ser removida em um plano revisado. Remova a
   configuração temporária do `sshd`, a chave temporária do
   `authorized_keys` e a chave privada temporária do notebook após o teste.

## Gate AWS

Pré-condição obrigatória: registrar a aprovação da rota privada até o Ollama
institucional ou da ponte SSH temporária acima. Sem um desses caminhos, pare
com zero réplicas.

- [ ] Caminho aprovado e responsável registrados na seção de evidências.
- [ ] Sessão `voclabs`, região `us-east-1`, workspace `default` e state local
  validados.
- [ ] Ler URL e model ID sem colocá-los no histórico:

  A URL deve usar diretamente o IPv4 RFC1918 alcançável pela VPC, sem DNS nem
  caminho adicional. Com a ponte SSH, use o IP privado do bastion já exportado.

  ```bash
  if [[ -z "${VIEW_SHOW_OLLAMA_BASE_URL:-}" ]]; then
    read -r -p "Ollama base URL reachable from the VPC: " VIEW_SHOW_OLLAMA_BASE_URL
  fi
  read -r -p "Ollama model ID: " VIEW_SHOW_OLLAMA_MODEL_ID
  export VIEW_SHOW_OLLAMA_BASE_URL
  ```

- [ ] Preparar observabilidade e worker com zero réplicas. Se a instância de
  observabilidade ainda não existir, o comando gera e confirma dois planos:
  primeiro somente a observabilidade; depois o worker, já com o endpoint OTLP
  privado conhecido. O exemplo abaixo usa a ponte; para uma rota privada direta,
  remova `--ssh-bridge`:

  ```bash
  node apps/scripts/aws-learner-lab.mjs analysis-prepare \
    --analysis-model apps/backend/agentic/models/approved.json \
    --analysis-catalog apps/backend/agentic/config/scope-catalog.pilot.json \
    --analysis-model-id "$VIEW_SHOW_OLLAMA_MODEL_ID" \
    --ssh-bridge
  ```

- [ ] Executar `analysis-check` e exigir exit code 0. No CloudWatch, confirmar o
  evento sanitizado `ollama_connectivity_ok` e a disponibilidade do model ID:

  ```bash
  node apps/scripts/aws-learner-lab.mjs analysis-check
  ```

- [ ] Se houver timeout, falha de rota/HTTP ou modelo ausente, manter
  `desired_count=0`, guardar apenas o código estável e encerrar o rollout.

- [ ] Ativar exatamente uma réplica. O comando repete o check e o validador
  aceita somente a transição `0 → 1`:

  ```bash
  node apps/scripts/aws-learner-lab.mjs analysis-activate
  ```

- [ ] Executar smoke e canário funcional:

  ```bash
  node apps/scripts/aws-learner-lab.mjs analysis-smoke
  node apps/scripts/aws-learner-lab.mjs analysis-canary
  ```

- [ ] Validar CloudWatch, Prometheus, Tempo e o dashboard
  `view-show-agentic-aws` no Grafana.
- [ ] Procurar `PROMPT_SMOKE_SENTINEL` e `RESPONSE_SMOKE_SENTINEL` no CloudWatch
  Logs Insights e registrar `0 ocorrências`:

  ```text
  fields @timestamp, @message
  | filter @message like /PROMPT_SMOKE_SENTINEL|RESPONSE_SMOKE_SENTINEL/
  | sort @timestamp desc
  | limit 20
  ```

- [ ] No CloudWatch Logs Insights, localizar o `trace_id` do evento sanitizado
  do smoke sem exibir o restante da linha:

  ```text
  fields @message
  | filter @message like /"event":"ollama_observability_smoke"/
  | parse @message '"trace_id":"*"' as trace_id
  | display trace_id
  | sort @timestamp desc
  | limit 1
  ```

- [ ] Abrir, em outro terminal, um túnel SSM temporário para a API do Tempo:

  ```bash
  OBSERVABILITY_INSTANCE="$(terraform -chdir=apps/fullstack output -raw observabilidade_instancia_id)"
  aws ssm start-session --region us-east-1 --profile default \
    --target "$OBSERVABILITY_INSTANCE" \
    --document-name AWS-StartPortForwardingSession \
    --parameters '{"portNumber":["3200"],"localPortNumber":["3200"]}'
  ```

- [ ] Em um terceiro terminal, informar o `trace_id` obtido acima, baixar o
  payload bruto e registrar `0 ocorrências` sem imprimir seu conteúdo:

  ```bash
  read -r -p "Smoke trace ID: " SMOKE_TRACE_ID
  printf '%s' "$SMOKE_TRACE_ID" | grep -Eq '^[a-f0-9]{32}$'
  umask 077
  TRACE_FILE="$(mktemp)"
  trap 'rm -f -- "$TRACE_FILE"' EXIT HUP INT TERM
  curl --fail --silent "http://127.0.0.1:3200/api/traces/$SMOKE_TRACE_ID" >"$TRACE_FILE"
  if grep -Eq 'PROMPT_SMOKE_SENTINEL|RESPONSE_SMOKE_SENTINEL' "$TRACE_FILE"; then
    echo "falha: conteúdo do smoke vazou para o trace" >&2
    exit 1
  fi
  echo "0 ocorrências"
  ```

- [ ] Observar ao menos dez minutos sem falhas do worker, do LLM ou da DLQ.

Se qualquer validação posterior à ativação falhar, execute o rollback seguro:

```bash
node apps/scripts/aws-learner-lab.mjs analysis-deactivate
```

O rollback lê o endpoint já implantado da revisão da task ECS; ele não depende
de `VIEW_SHOW_OLLAMA_BASE_URL` continuar definido no terminal.

Não execute `terraform apply` diretamente e não crie `*.tfvars`.

## Evidências sanitizadas

Preencha somente os campos abaixo. Use nomes e IDs técnicos; omita endpoint do
Ollama, IP privado, credenciais, payloads, entradas/saídas do modelo e logs
completos.

| Campo | Evidência |
|---|---|
| Data/hora e ambiente | |
| Commit SHA | |
| `service.version` | |
| Nome do modelo | |
| Rota aprovada / responsável | |
| Task ARN do check | |
| Exit code do check | |
| Dashboard local (`view-show-agentic`) | |
| Dashboard AWS (`view-show-agentic-aws`) | |
| Contagens e latências agregadas | |
| Resultado da busca de vazamento | `0 ocorrências` / pendente |
| Início/fim da observação de 10 min | |
| Resultado final | aprovado / rollback / bloqueado |

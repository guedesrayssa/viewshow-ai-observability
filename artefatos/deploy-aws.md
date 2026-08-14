# Implantação na AWS — MVP da Sprint 1

Roteiro para colocar a API em uma instância EC2, os dados em uma tabela
DynamoDB e o painel em um bucket S3, dentro do laboratório da AWS Academy.

Região usada em tudo: **us-east-1**.

---

## Resumo: a rotina de cada sessão do laboratório

Depois que este roteiro for executado **uma vez**, começar a trabalhar de novo
custa três passos:

1. Iniciar o laboratório na AWS Academy.
2. No console EC2, selecionar a instância e clicar em **Instance state → Start**.
3. Esperar cerca de 40 segundos.

A API volta sozinha, no mesmo endereço, com os dados que já estavam lá. Não é
preciso entrar por SSH, reinstalar nada nem semear a base outra vez.

Só é necessário mexer no AWS CLI local quando for republicar o frontend — as
credenciais do laboratório expiram a cada sessão e precisam ser recopiadas de
**AWS Details → AWS CLI**.

---

## O que sobrevive ao fim da sessão

| Recurso | Ao fim das 4 horas | Consequência |
| --- | --- | --- |
| Instância EC2 | É **parada**, não destruída | O disco continua intacto: código, venv e configuração permanecem |
| Volume EBS | Preservado | Nada precisa ser reinstalado |
| Bucket S3 | Preservado | O painel continua publicado |
| Tabela DynamoDB | Preservada | Os dados semeados continuam lá, respeitado o TTL de 24 h |
| IP público comum | **Muda** a cada Start | Quebraria o `config.js` já publicado — resolvido com Elastic IP |
| Processos em execução | Morrem | Resolvido com o serviço do systemd habilitado |
| Credenciais do AWS CLI | **Expiram** | Só afeta a máquina local; a EC2 usa a role da instância |

Os dois problemas reais — o IP e os processos — são exatamente o que o Elastic
IP e o `systemctl enable` resolvem. É por isso que os dois passos abaixo não
são opcionais.

---

## Fase 1 — Instância EC2

### 1.1 Criar

No console EC2, **Launch instance**:

| Campo | Valor |
| --- | --- |
| Name | `g05-telemetria-api` |
| AMI | Amazon Linux 2023 |
| Tipo | `t3.micro` |
| Key pair | criar `g05-key` e **salvar o arquivo `.pem`** |
| **IAM instance profile** | **`LabInstanceProfile`** |

O instance profile é o campo mais fácil de esquecer e o mais caro de corrigir:
é ele que dá à instância acesso ao DynamoDB sem nenhuma chave escrita em
arquivo. Fica em **Advanced details**, bem no fim do formulário. Sem ele, a API
sobe e falha em toda consulta com `NoCredentialsError`.

### 1.2 Security group

| Tipo | Porta | Origem |
| --- | --- | --- |
| SSH | 22 | **My IP** |
| HTTP | 80 | `0.0.0.0/0` |

### 1.3 Elastic IP

Em **Network & Security → Elastic IPs**:

1. **Allocate Elastic IP address** → Allocate.
2. Selecionar o endereço → **Actions → Associate** → escolher a instância.

Anote o endereço. Ele é o `<IP>` de todo o resto deste roteiro e **não muda**
quando a instância é parada e ligada de novo. É o que faz o `config.js`
publicado no S3 continuar válido na próxima sessão.

> Se a alocação for bloqueada pelo laboratório, siga sem Elastic IP. O conserto
> passa a ser rodar `deploy-frontend.sh` com o IP novo no começo de cada sessão,
> o que leva cerca de dez segundos.

### 1.4 Conectar e instalar

```bash
chmod 400 g05-key.pem
ssh -i g05-key.pem ec2-user@<IP>
```

Já dentro da instância:

```bash
sudo dnf update -y
sudo dnf install -y git python3.11 python3.11-pip
```

> **O Python do sistema não serve.** O `/usr/bin/python3` do Amazon Linux 2023 é
> o 3.9 e continuará sendo pelo resto da vida da distribuição, enquanto a
> aplicação exige 3.10 ou mais recente. Com o 3.9 a API até sobe, e só quebra
> quando alguém abre a série temporal ou o detalhe de um erro — o pior momento
> possível para descobrir. Por isso o `python3.11` é instalado ao lado e usado
> explicitamente na criação do ambiente virtual.
>
> **Não troque o symlink** `/usr/bin/python3` para o 3.11: o `dnf` é escrito
> para o 3.9 e para de funcionar. Cada versão convive com a outra pelo nome.

Confira antes de seguir:

```bash
python3.11 --version    # deve mostrar 3.11.x
```

### 1.5 Trazer o código

O repositório é privado, então o `git clone` precisa de credencial. O caminho
repetível é um **deploy token** de leitura, criado no GitLab em
*Settings → Repository → Deploy tokens* com o escopo `read_repository`:

```bash
git clone https://<usuario-do-token>:<token>@git.inteli.edu.br/graduacao/2026-2a/t15/g05.git
```

Alternativa sem token, copiando da máquina local:

```bash
# rodar na máquina local, não na instância
scp -i g05-key.pem -r apps ec2-user@<IP>:~/g05/
```

### 1.6 Ambiente Python

```bash
cd ~/g05/apps/basica/backend
python3.11 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
.venv/bin/python --version    # confirme que é 3.11.x
```

---

## Fase 2 — Tabela DynamoDB

Criada a partir da própria instância, que já tem a role anexada e dispensa
configurar credenciais:

```bash
cd ~/g05/apps/basica/backend
AWS_REGION=us-east-1 .venv/bin/python scripts/create_dynamodb_table.py
```

Saída esperada:

```
Tabela `telemetry` criada com o índice `trace-index` e TTL em `expires_at`.
```

O script é idempotente: rodar de novo apenas informa que a tabela já existe.
Se em vez disso aparecer um erro de credenciais, o `LabInstanceProfile` não foi
anexado — corrija em **Actions → Security → Modify IAM role** e reinicie a
instância.

Conferência rápida:

```bash
aws dynamodb describe-table --table-name telemetry --region us-east-1 \
    --query 'Table.[TableStatus,KeySchema,GlobalSecondaryIndexes[0].IndexName]'
```

Deve devolver `ACTIVE`, as chaves `pk`/`sk` e o índice `trace-index`.

---

## Fase 3 — Subir a API como serviço

```bash
sudo cp ~/g05/apps/basica/deploy/telemetria.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telemetria
systemctl status telemetria --no-pager
```

`CORS_ORIGINS` ainda está com o valor de exemplo; ele é ajustado na Fase 5,
depois que o bucket existir.

Teste local, dentro da instância:

```bash
curl -s "http://localhost/v1/analytics/errors/summary?window=24h"
```

E de fora, da sua máquina:

```bash
curl -s "http://<IP>/v1/analytics/errors/summary?window=24h"
```

Se o primeiro funcionar e o segundo não, o problema é o security group.

### Semear os dados da demonstração

```bash
cd ~/g05/apps/basica/backend
.venv/bin/python scripts/seed_demo.py --base-url http://localhost
```

Devolve 420 eventos, 101 erros e 180 heartbeats aceitos.

> **A retenção é de 24 horas.** A aplicação descarta registros mais antigos e o
> TTL do DynamoDB apaga os itens vencidos. Rode este comando de novo no dia da
> gravação do vídeo e no dia dos testes do Postman.

---

## Fase 4 — Bucket S3

Da **máquina local**, com as credenciais do laboratório coladas em
`~/.aws/credentials` (copiadas de **AWS Details → AWS CLI**):

```bash
BUCKET=g05-telemetria-front      # precisa ser único no mundo; ajuste se der conflito

aws s3api create-bucket --bucket $BUCKET --region us-east-1
aws s3api delete-public-access-block --bucket $BUCKET

aws s3api put-bucket-policy --bucket $BUCKET --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"LeituraPublica\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/*\"
  }]
}"

aws s3 website "s3://$BUCKET" --index-document index.html --error-document index.html
```

Publicar a página apontada para a API:

```bash
cd apps/basica/deploy
./deploy-frontend.sh $BUCKET http://<IP>
```

O script imprime a URL final, no formato:

```
http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com
```

> **Use essa URL, e não a do endpoint REST** (`https://<bucket>.s3.amazonaws.com`).
> O endpoint REST é HTTPS, e uma página HTTPS não tem permissão de chamar uma
> API em HTTP: o navegador bloqueia por conteúdo misto, sem mensagem clara na
> tela. O endpoint de site é HTTP, igual à API, e por isso funciona. É também a
> razão de não haver CloudFront nesta sprint.

---

## Fase 5 — Amarrar o CORS

Na instância, com a URL do site em mãos:

```bash
sudo sed -i 's|^Environment="CORS_ORIGINS=.*|Environment="CORS_ORIGINS=http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com"|' \
    /etc/systemd/system/telemetria.service
sudo systemctl daemon-reload
sudo systemctl restart telemetria
```

Conferir que o cabeçalho é devolvido para a origem certa e negado para as
demais:

```bash
# deve imprimir a URL do bucket
curl -s -D- -o /dev/null -H "Origin: http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com" \
    "http://<IP>/v1/analytics/errors/summary?window=24h" | grep -i access-control-allow-origin

# não deve imprimir nada
curl -s -D- -o /dev/null -H "Origin: http://exemplo-qualquer.com" \
    "http://<IP>/v1/analytics/errors/summary?window=24h" | grep -i access-control-allow-origin
```

O endereço precisa bater **exatamente**: mesmo protocolo, mesmo host, sem barra
no final. `http://` e `https://` são origens diferentes para o navegador.

---

## Fase 6 — Verificação final

1. Abrir a URL do site em uma aba anônima.
2. Abrir o DevTools antes de recarregar.
3. Conferir:
   - o selo do topo mostra **API conectada**;
   - os quatro cartões de erro e os quatro de QoE estão preenchidos;
   - o gráfico "Evolução no tempo" tem barras;
   - o ranking lista os seis códigos de erro;
   - clicar em um erro preenche o painel "Detalhe";
   - o console não tem nenhum erro;
   - na aba Network, os cinco `GET` respondem 200.

Teste de ponta a ponta que vale para o relatório — um `POST` novo aparecendo em
um `GET`:

```bash
curl -s -X POST "http://<IP>/v1/telemetry/errors" \
    -H "Content-Type: application/json" \
    -d '{"session_id":"sess-teste","error_code":"TESTE_POSTMAN","message":"validação do relatório","fatal":true,"module":"player"}'

curl -s "http://<IP>/v1/analytics/errors/top?window=24h&limit=20" | grep TESTE_POSTMAN
```

---

## Quando algo der errado

| Sintoma | Causa provável | Verificação |
| --- | --- | --- |
| Painel vazio, console acusa CORS | `CORS_ORIGINS` não bate com a URL do site | `systemctl show telemetria -p Environment` |
| Painel vazio, sem erro de CORS | Base sem dados na janela | rodar `seed_demo.py` de novo |
| `fetch` falha e nada aparece na Network | Página aberta pelo endpoint REST (HTTPS) | usar a URL `s3-website-…` |
| API não responde de fora | Porta 80 fechada | conferir o security group |
| API não responde nem de dentro | Serviço caiu | `journalctl -u telemetria -n 50 --no-pager` |
| Log diz "A aplicação exige Python 3.10" | Venv criado com o `python3` do sistema (3.9) | `rm -rf .venv` e refazer com `python3.11 -m venv .venv` |
| `NoCredentialsError` no log | Instance profile ausente | anexar `LabInstanceProfile` e reiniciar |
| Números mudam a cada F5 | Rodando com backend `memory` e vários workers | conferir `TELEMETRY_BACKEND=dynamodb` |
| Painel vazio depois de um dia | Retenção de 24 h expirou | rodar `seed_demo.py` |
| Consultas lentas com janelas grandes | Uma consulta por bucket de 1 h | aumentar `DYNAMODB_BUCKET_SECONDS` |

Uma janela de 24 h gera 75 consultas ao DynamoDB por chamada de
`/errors/summary` — 25 buckets de uma hora vezes três tipos de registro,
disparadas 8 a 8 em paralelo. É confortável nessa escala. Uma janela de 30 dias
geraria mais de duas mil, e aí o parâmetro `DYNAMODB_BUCKET_SECONDS` passa a
importar. O painel consulta sempre 24 h, definidos em `ANALYTICS_WINDOW` no
`config.js` do frontend.

---

## Comandos de uso diário

```bash
# estado e log da API
systemctl status telemetria --no-pager
journalctl -u telemetria -f

# reiniciar após mudar a configuração
sudo systemctl daemon-reload && sudo systemctl restart telemetria

# republicar o frontend
cd apps/basica/deploy && ./deploy-frontend.sh $BUCKET http://<IP>

# repovoar a base
cd ~/g05/apps/basica/backend && .venv/bin/python scripts/seed_demo.py --base-url http://localhost

# quantos registros existem na tabela
aws dynamodb scan --table-name telemetry --select COUNT --region us-east-1 --query Count
```

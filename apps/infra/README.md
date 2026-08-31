# Infraestrutura — View Show num AWS Academy Learner Lab

Terraform que provisiona a demonstração completa do View Show (painel + API
operacional + dados) dentro de um Learner Lab individual, sozinho, sem tocar
no console.

## O que sobe

Uma única EC2 rodando:

- o painel (Next.js, exportado como HTML estático)
- a API operacional (Node/Express, `apps/backend/api`)
- um nginx na frente, servindo os dois na mesma origem

Mais as duas tabelas DynamoDB que a API usa (`monitoracao-operacional`,
`monitoracao-golden-set`) e um bucket S3 privado, que existe só para levar o
código até a instância — não é o que serve o painel.

**Não sobe** a API de telemetria em Flask (`apps/basica`). As telas que
dependem só dela mostram o conjunto de exemplo do próprio frontend, rotulado
como tal na tela — nunca um número sem procedência. Ver
`var.permitir_dado_exemplo` em [`variables.tf`](variables.tf).

**Não usa** ECS, ECR nem Load Balancer. O motivo é orçamento: o Learner Lab
para instâncias EC2 quando a sessão termina, mas **não** desliga Fargate nem
Load Balancer — eles continuam cobrando entre sessões, e o orçamento do lab é
de US$ 100. Uma EC2 é o único destes componentes que a AWS desliga sozinha.

## Por que uma origem só

Painel e API são servidos pelo mesmo nginx, na mesma porta. Isso resolve três
problemas de uma vez, sem mudar código de aplicação:

- **CORS** deixa de existir — requisição same-origin não é cross-origin.
- **Conteúdo misto** some — um único esquema, HTTP.
- **O cookie de sessão volta a funcionar** — `SameSite=Lax` exige same-site, e
  same-origin é same-site por definição. (O outro defeito do cookie, a flag
  `Secure` que o descartaria em HTTP puro, nem chega a aparecer aqui: como a
  API roda como processo Node direto — não a imagem Docker do repositório —
  simplesmente não definimos `NODE_ENV=production` no systemd. Ver o
  comentário em `templates/user_data.sh.tftpl`.)

E, de graça: o endereço da API não precisa ser conhecido antes do build do
painel. O Next lê `NEXT_PUBLIC_API_BASE_URL="/"` e resolve para
`window.location.origin` no navegador (ver `lib/data/client.ts` e
`lib/auth.ts`), então o mesmo build funciona em qualquer IP, em qualquer
sessão do lab.

## Como o código chega na instância

O GitLab deste projeto é privado e auto-hospedado — uma EC2 recém-criada não
tem como cloná-lo. Em vez de uma credencial de repositório embutida no
provisionamento, o `apply` empacota `apps/backend/api` e `apps/frontend` (sem
`node_modules`) com o data source nativo `archive_file` — sem chamar `zip`
nem nenhum binário externo, então funciona igual em Linux e Windows — e sobe
os dois zips para um bucket S3 privado. A instância baixa de lá com a própria
role (`LabInstanceProfile`), sem nenhuma credencial em lugar nenhum.

A chave do objeto S3 inclui o hash do conteúdo. Mudar o código gera uma chave
nova, o que muda o `user_data` da instância, e com
`user_data_replace_on_change = true` isso cria uma instância nova já com o
código atualizado — não existe um passo de "reimplantar" separado do
`terraform apply`.

## Pré-requisitos

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.7, **ou**
  Docker (dá para rodar tudo pelo container oficial, sem instalar nada — ver
  abaixo). Nada mais: o build do Next e o `npm ci` da API rodam dentro da
  instância, não na sua máquina.
- Uma sessão ativa de AWS Academy Learner Lab, com as credenciais coladas em
  `~/.aws/credentials`.

### Credenciais do Learner Lab

O Learner Lab dá três valores em **AWS Details → AWS CLI**, mas
`aws configure` só pergunta por dois. Cole o bloco à mão:

```ini
# ~/.aws/credentials
[g05-lab]
aws_access_key_id=ASIA...
aws_secret_access_key=...
aws_session_token=...
```

E aponte o Terraform para esse perfil antes de qualquer comando:

```bash
export AWS_PROFILE=g05-lab          # Linux/macOS
$env:AWS_PROFILE = "g05-lab"        # Windows, PowerShell
```

Essas credenciais expiram com a sessão (~4 horas). Recopie o bloco acima
sempre que reiniciar o lab.

## Uso

```bash
cd apps/infra
terraform init      # uma vez, ou de novo se algum provider mudar
terraform plan       # confere o que vai ser criado antes de aplicar
terraform apply
```

Sem Terraform instalado, o binário é um arquivo só — não precisa de `apt`,
`brew` nem privilégio de administrador:

```bash
# Linux/macOS: baixa para um diretório que já está no PATH
mkdir -p ~/.local/bin
curl -fsSL -o terraform.zip \
  https://releases.hashicorp.com/terraform/1.16.0/terraform_1.16.0_$(uname -s | tr A-Z a-z)_amd64.zip
unzip -o -q terraform.zip -d ~/.local/bin && rm terraform.zip
terraform version
```

No Windows, baixe o `.zip` da mesma página e extraia `terraform.exe` para uma
pasta do `PATH` (ou use `winget install HashiCorp.Terraform`).

Só se nenhuma das duas opções servir, dá para rodar pelo container oficial —
mas **inclua `--user`**, senão o container escreve `terraform.tfstate` como
`root` e o próximo comando trava com `permission denied`:

```bash
docker run --rm -it --user "$(id -u):$(id -g)" \
  -v "${PWD}/../..":/repo -w /repo/apps/infra \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  hashicorp/terraform:latest apply
```

(O volume monta o repositório inteiro, não só `apps/infra`, porque o
`archive_file` também lê `apps/backend/api` e `apps/frontend`.)

Se você já rodou sem `--user` e travou nisso, o conserto é devolver os
arquivos para o seu usuário — de novo, com Docker, já que foi ele quem os
criou como `root`:

```bash
docker run --rm -v "$PWD":/infra alpine chown -R "$(id -u):$(id -g)" /infra
```

## Como encontrar o link do deploy

O `terraform apply` já termina imprimindo a URL na tela, na seção
`Outputs:`, assim:

```
Outputs:

painel_url = "http://54.x.x.x"
```

Se você fechou o terminal ou quer o link de novo depois, rode isto de dentro
de `apps/infra` (não precisa aplicar nada de novo):

```bash
terraform output painel_url
```

Ou, sem aspas em volta — útil para colar num navegador ou usar em outro
script:

```bash
terraform output -raw painel_url
```

**A URL não muda entre sessões do laboratório** — é o Elastic IP que garante
isso (ver `compute.tf`). O link de hoje continua valendo depois de você
fechar e reabrir o lab amanhã, mesmo com a instância tendo sido parada e
religada no meio.

O painel só responde de verdade **3 a 4 minutos depois** de o `apply`
terminar — é o tempo do bootstrap dentro da instância (instalar, compilar,
semear). Se abrir a URL antes disso, o normal é dar timeout ou conexão
recusada; espere e recarregue.

## O que o `apply` faz sozinho, sem SSH

1. Cria as duas tabelas DynamoDB.
2. Empacota o código e sobe para o bucket de artefatos.
3. Sobe a EC2, associa o Elastic IP.
4. Dentro da instância (`templates/user_data.sh.tftpl`), no primeiro boot:
   - instala Node 22, nginx;
   - baixa e instala as duas aplicações;
   - sobe a API como serviço systemd (`monitoracao-api`);
   - compila o painel com o endereço da API resolvido em tempo de execução;
   - configura o nginx para servir os dois na mesma origem;
   - roda `npm run seed`, que popula as duas tabelas.

## Depois do apply

```bash
terraform output painel_url              # a URL
terraform output comando_ssh             # SSH de depuração, com a chave já pronta
terraform output comando_logs_bootstrap  # acompanha o provisionamento em tempo real
terraform output comando_seed            # repovoa os dados sem esperar reiniciar
```

## Entre sessões do laboratório

O Elastic IP não muda entre sessões, então a mesma URL continua válida. Ao
final da sessão a AWS **para** a instância (não destrói); ao religar, a API
volta sozinha porque o serviço está `enabled` no systemd — mas os **dados
não se renovam sozinhos** nesse caso, porque o `npm run seed` só roda no
primeiro boot da instância, e não a cada `start`.

Duas opções, dependendo do que você precisa:

- **Só reabrir a demo**: religue a instância no console (`Instance state →
  Start`) e espere ~40s. Não precisa rodar Terraform de novo.
- **Dado fresco de novo**: rode `terraform output comando_seed` (repovoa sem
  reiniciar nada) — ou, se preferir recomeçar do zero, `terraform apply`
  sem mudar nada é um no-op (a instância parada não aparece como drift); para
  forçar uma instância nova, o caminho mais simples é
  `terraform taint aws_instance.app && terraform apply`.

Se o crédito do laboratório importa, `terraform destroy` no fim de cada
sessão custa 3-4 minutos a menos na sessão seguinte e garante que nada fica
cobrando entre uma sessão e outra — as tabelas DynamoDB e o bucket também são
recriados no próximo `apply`, então nenhum dado "de produção" se perde com
isso.

## Se o `apply` falhar

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `ExpiredToken` / `InvalidClientTokenId` no meio do apply | Sessão do lab expirou | Reinicie o lab, recole as credenciais, rode `terraform apply` de novo — ele retoma do que falta |
| `ResourceInUseException: Table already exists` | Alguém já criou `monitoracao-operacional`/`golden-set` na mão neste mesmo lab | `terraform import aws_dynamodb_table.operacional monitoracao-operacional` (e o mesmo para a golden set), ou apague a tabela feita na mão |
| `UnauthorizedOperation` / `AccessDenied` num recurso | O nome do instance profile não é `LabInstanceProfile` neste ambiente | Confira no console (EC2 → Instâncias → uma existente → IAM Role) e ajuste `var.nome_perfil_instancia` |
| Painel abre mas todas as telas dizem "indisponível" | O bootstrap ainda não terminou, ou falhou no meio | `terraform output comando_logs_bootstrap` e acompanhe `/var/log/g05-bootstrap.log` |
| `nginx: [emerg]` nos logs | Configuração gerada não validou (`nginx -t` roda antes do `systemctl restart` e aborta o script se falhar) | Mesmo log acima mostra a linha exata que falhou |
| Nenhuma tela mostra dado real, só "Dados de exemplo" | Normal se a semeadura falhou silenciosamente, ou se você reiniciou a instância (o seed não repete sozinho, ver acima) | `terraform output comando_seed` |
| No Windows, `terraform apply` reclama de permissão do arquivo `.pem` | Normal — o SSH do Windows é mais tolerante que o do Linux, mas se travar, restrinja com `icacls g05-view-show.pem /inheritance:r /grant:r "$($env:USERNAME):(R)"` | — |

## Variáveis

Ver [`variables.tf`](variables.tf) — todas têm default e nenhuma exige
preenchimento para o caminho comum. As mais prováveis de mexer:

- `permitir_dado_exemplo` — `false` se você não quiser o rótulo "Dados de
  exemplo" em tela nenhuma (então as telas que dependem da telemetria Flask
  mostram "indisponível").
- `auth_senha` — troque se a demo vai ficar acessível para além do grupo.
- `tipo_instancia` — suba para `t3.medium` se o build do Next parecer lento
  demais no `t3.small` default.

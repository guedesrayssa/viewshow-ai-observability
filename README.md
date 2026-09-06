<div align="center">
  <h5>Um projeto do Instituto de Tecnologia e Liderança</h5>
  <a href="https://www.inteli.edu.br/">
    <img src="./assets/logo-inteli.png" alt="Inteli" width="120px">
  </a>
  <h5>Parceiro do Módulo: Grupo Globo — Globoplay</h5>
  <a href="https://www.globo.com/">
    <img src="./assets/logo-globo.png" alt="Globo" width="180px">
  </a>
</div>

# View Show — Plataforma de Telemetria de Frontend do Globoplay

<div align="center">
  <img src="./assets/logo-view-show.png" alt="View Show" width="100px">
</div>

**Grupo 05 — Os Big Brothers**
Módulo 7, Engenharia de Software — Inteli
**Parceiro:** Grupo Globo (Globoplay)

## Integrantes

| Integrante |
| --- |
| [**João Freitas**](https://www.linkedin.com/in/joao-freitas/) |
| [**Raiane Araujo Brandão**](https://www.linkedin.com/in/raianearaujobrandao/) |
| [**Rayssa Guedes França**](https://www.linkedin.com/in/rayssaguedess/) |
| [**Messias Olivindo**](https://www.linkedin.com/in/messias-olivindo/) |
| [**Victor Garcia dos Santos**](https://www.linkedin.com/in/victor-garcia-dos-santos/) |
| [**Marcos Vinicius M. Silva**](https://www.linkedin.com/in/marcos-vinicius-m-silva/) |
| [**Lucas Michel Pereira**](https://www.linkedin.com/in/lucas-michel-pereira-1a338734b/) |
| [**Bruno Martins**](https://www.linkedin.com/in/bruno-martins-2b6742269/) |

---

## Descrição do projeto

As plataformas de monitoração de mercado pressupõem protocolos modernos e um parque
de dispositivos homogêneo, o que deixa de fora justamente a base real do Globoplay:
Smart TVs fabricadas entre 2013 e 2026, com pouca capacidade de processamento e sem
suporte aos SDKs atuais de telemetria — de modo que falhas de reprodução nesses
aparelhos só chegam à engenharia pelo relato do usuário, sem dado que permita
diagnosticar a causa. O **View Show** é uma plataforma proprietária de telemetria que
recebe eventos de reprodução, erros e sinais de presença emitidos por qualquer
frontend, normaliza tudo em um formato único e expõe indicadores de qualidade de
experiência e de falhas por meio de uma API de consulta e de um painel, permitindo que
as equipes de engenharia e observabilidade enxerguem a degradação enquanto ela
acontece, em vez de depois do fato.

Em escala plena, a solução coleta, normaliza, processa e correlaciona telemetria de
aplicações frontend e de diferentes sistemas de monitoração, identificando anomalias,
delimitando os usuários e ambientes afetados e apresentando hipóteses ranqueadas para a
causa provável de cada incidente. O objetivo é dar aos times uma visão ponta a ponta da
experiência do assinante, reduzindo a dependência de análises manuais em múltiplos
painéis.

## Objetivos do MVP

- Disponibilizar uma API unificada para ingestão de eventos de telemetria
- Suportar dispositivos e protocolos modernos e legados
- Processar e armazenar grandes volumes de eventos com resiliência e sem perdas
- Normalizar eventos provenientes de fontes e formatos diferentes
- Correlacionar sinais de múltiplos componentes do ecossistema Globoplay
- Detectar anomalias e apresentar hipóteses de causa provável com suas evidências
- Exibir métricas, alertas e eventos em um painel com filtros cumulativos
- Permitir o aprofundamento da análise até o nível de sessão e fonte de dados

---

## Análise do dump Argus

O laboratório reprodutível de exploração do dump MySQL, incluindo setup local,
fixture sanitizado e notebooks, está em
[artefatos/extras/analysis/README.md](artefatos/extras/analysis/README.md).

## Estrutura de pastas

| Pasta | Conteúdo |
| --- | --- |
| `/artefatos` | Documentação: requisitos, arquitetura do backend, análise financeira, roteiro de implantação na AWS, relatório de testes e a coleção do Postman |
| `/apps/basica` | Aplicação da Sprint 1: `backend` (API em Flask), `frontend` (painel estático) e `deploy` (artefatos de implantação) |
| `/apps/infra` | Terraform que reproduz a arquitetura da Sprint 2 — ECS Fargate, ALB, ECR, Amplify e DynamoDB — num AWS Academy Learner Lab individual, com um `terraform apply` |
| `/assets` | Imagens e logos usados na documentação |
| `/slides` | Apresentações das sprints |

```text
/
├── README.md
├── .gitignore
├── apps/basica/
│   ├── backend/
│   │   ├── app/{controllers,domain,repositories,services}/
│   │   ├── scripts/
│   │   └── tests/
│   ├── frontend/{index.html, app.js, api.js, config.js, styles.css, fonts/}
│   └── deploy/{telemetria.service, deploy-frontend.sh}
├── artefatos/{mvp-inicial.md, backend.md, requisitos.md, deploy-aws.md, ...}
├── assets/
└── slides/
```

---

## Execução local

Requer **Python 3.10 ou superior** e um navegador. Nada além disso: o painel é HTML,
CSS e JavaScript servidos como estão, sem etapa de build.

```bash
git clone https://git.inteli.edu.br/graduacao/2026-2a/t15/g05.git
cd g05/apps/basica/backend

python3 -m venv .venv
source .venv/bin/activate          # no Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

python wsgi.py                     # API em http://127.0.0.1:5000
```

Em outro terminal, popule a base e sirva o painel:

```bash
cd apps/basica/backend
.venv/bin/python scripts/seed_demo.py          # dados de demonstração

cd ../frontend
python3 -m http.server 5173                    # painel em http://localhost:5173
```

O painel já vem apontado para `http://localhost:5000`. Para apontá-lo a outra API,
altere `API_BASE_URL` em `apps/basica/frontend/config.js` — é o único arquivo que muda
entre ambientes.

Sem configuração adicional a API guarda os dados em memória, e eles somem ao reiniciar.
Para persistir no DynamoDB, veja [`artefatos/backend.md`](artefatos/backend.md).

### Testes

```bash
cd apps/basica/backend
.venv/bin/python -m unittest discover -s tests -t .   # 160 testes
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

Os testes de GET e POST da API estão na coleção do Postman em
[`artefatos/postman`](artefatos/postman). Importe a coleção e o ambiente `local`, ou
rode pela linha de comando:

```bash
npx newman run artefatos/postman/telemetria-globoplay.postman_collection.json \
    -e artefatos/postman/local.postman_environment.json
```

Os resultados estão consolidados no
[relatório de testes do MVP inicial](artefatos/mvp-inicial.md).

### GitHub Codespaces

Abra o repositório em um Codespace e execute os mesmos comandos acima. O Codespace já
traz Python 3 e Node; as portas 5000 e 5173 são encaminhadas automaticamente, e o
painel funciona pela URL pública encaminhada sem nenhum ajuste, porque a API libera
CORS para qualquer origem no modo padrão.

---

## Execução na AWS

A aplicação roda com a API em uma instância **EC2**, os dados no **DynamoDB** e o
painel publicado como site estático em um bucket **S3**.

O passo a passo completo — criação da instância, Elastic IP, provisionamento da tabela,
serviço do systemd, bucket, CORS e verificação final — está em
[`artefatos/deploy-aws.md`](artefatos/deploy-aws.md).

Resumo dos comandos, com a infraestrutura já criada:

```bash
# na instância EC2
sudo cp apps/basica/deploy/telemetria.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now telemetria

# publica o painel apontado para a API
cd apps/basica/deploy
./deploy-frontend.sh <nome-do-bucket> http://<ip-da-ec2>
```

Como o ambiente é um laboratório da AWS Academy, cuja sessão encerra após quatro horas,
a instância é configurada com Elastic IP e com o serviço habilitado no systemd. Isso faz
a API voltar sozinha, no mesmo endereço, bastando iniciar a instância na sessão seguinte.

---

## Provisionamento automatizado (Terraform, Learner Lab individual)

Além do runbook manual acima — que sobe a stack da Sprint 1 (`apps/basica`) —
o diretório [`apps/infra`](apps/infra) reproduz a **arquitetura da Sprint 2**
(painel Next.js no Amplify, API operacional em ECS Fargate atrás de um ALB,
imagem no ECR e as duas tabelas DynamoDB) dentro do próprio AWS Academy Learner
Lab de quem está rodando, com um único comando:

```bash
cd apps/infra
terraform init
terraform apply
```

De 8 a 15 minutos depois, `terraform output painel_url` devolve o endereço do
painel já com dado: o mesmo `apply` constrói e publica a imagem no ECR, compila
e publica o painel no Amplify e semeia as tabelas. Pré-requisitos locais:
Terraform, Docker e Node.

Duas coisas que valem saber antes de rodar. O login, registrado como quebrado em
[`ci-cd-amplify.md`](artefatos/sprint2/ci-cd-amplify.md), **funciona aqui** — o
Amplify repassa `/api`, `/auth` e `/health` para a API, o que coloca painel e API
na mesma origem e faz o cookie de sessão voltar a valer. E, ao contrário da EC2,
**o ALB e o Fargate não são desligados pelo "End Lab"**: rode `terraform destroy`
ao fim de cada sessão, ou eles seguem cobrando do orçamento do laboratório.

Detalhes de pré-requisitos, credenciais do lab, variáveis, [como encontrar o
link do deploy depois de fechar o
terminal](apps/infra/README.md#como-encontrar-o-link-do-deploy), o que fazer
entre sessões e uma tabela de "se der erro, é isto" estão em
[`apps/infra/README.md`](apps/infra/README.md).

---

## Documentação adicional

- [Arquitetura técnica atual e contratos para desenvolvimento](artefatos/arquitetura/README.md)
- [Relatório de testes do MVP inicial](artefatos/mvp-inicial.md)
- [Arquitetura e endpoints do backend](artefatos/backend.md)
- [Especificação de requisitos](artefatos/requisitos.md)
- [Roteiro de implantação na AWS](artefatos/deploy-aws.md)
- [CI/CD do painel no AWS Amplify](artefatos/ci-cd-amplify.md)
- [Análise financeira](artefatos/analise_financeira.md)

---

## Histórico de lançamentos

- **SPRINT 5**

- **SPRINT 4**

- **SPRINT 3**

- **SPRINT 2**

- **SPRINT 1**
  - Entendimento do negócio e do problema do parceiro
  - Definição do escopo e do MVP
  - Requisitos funcionais e não funcionais
  - Personas, jornadas e histórias de usuário
  - Análise das fontes de dados e proposta de arquitetura
  - API de ingestão e consulta implantada em EC2, com persistência em DynamoDB
  - Painel publicado como página estática em S3
  - Coleção de testes no Postman e relatório de resultados

---

## Licença

<p xmlns:cc="http://creativecommons.org/ns#" xmlns:dct="http://purl.org/dc/terms/">
  <a property="dct:title" rel="cc:attributionURL" href="https://git.inteli.edu.br/graduacao/2026-2a/t15/g05">View Show</a> por
  <a rel="cc:attributionURL dct:creator" property="cc:attributionName">João, Raiane, Rayssa, Messias, Victor, Marcos, Lucas e Bruno</a>
  é licenciado sob
  <a href="http://creativecommons.org/licenses/by/4.0/?ref=chooser-v1" target="_blank" rel="license noopener noreferrer" style="display:inline-block;">
    Attribution 4.0 International (CC BY 4.0)
    <img style="height:22px!important;margin-left:3px;vertical-align:text-bottom;" src="https://mirrors.creativecommons.org/presskit/icons/cc.svg?ref=chooser-v1">
    <img style="height:22px!important;margin-left:3px;vertical-align:text-bottom;" src="https://mirrors.creativecommons.org/presskit/icons/by.svg?ref=chooser-v1">
  </a>
</p>
